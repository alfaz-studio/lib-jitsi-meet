import { getLogger } from '@jitsi/logger';
import { $iq, $msg } from 'strophe.js';

import { MediaType } from '../../service/RTC/MediaType';
import type XmppConnection from '../xmpp/XmppConnection';

const logger = getLogger('cloudflare:TrackSubscriptionManager');

/**
 * Information about a remote track available in the conference.
 */
export interface IRemoteTrackInfo {
    trackId: string;
    trackType: 'audio' | 'video';
    participantId: string;
    trackLabel?: string;
    streamId?: string;
    ssrc?: string;
}

/**
 * Subscription quality constraints for video tracks.
 */
export interface IVideoConstraints {
    maxHeight?: number;
    maxWidth?: number;
    maxFramerate?: number;
}

/**
 * TrackSubscriptionManager handles client-side track subscription logic for Cloudflare SFU.
 * This replaces the server-side LastN and ReceiverVideoConstraints used with JVB.
 */
export default class TrackSubscriptionManager {
    private _connection: XmppConnection;
    private _roomJid: string;
    private _availableTracks: Map<string, IRemoteTrackInfo> = new Map();
    private _subscribedTracks: Set<string> = new Set();
    private _videoConstraints: Map<string, IVideoConstraints> = new Map();
    private _maxSubscribedVideoTracks: number = 20; // Default LastN equivalent
    private _dominantSpeaker: string | null = null;
    private _onTrackAvailable?: (trackInfo: IRemoteTrackInfo) => void;
    private _onTrackUnavailable?: (trackInfo: IRemoteTrackInfo) => void;

    /**
     * Creates a new TrackSubscriptionManager instance.
     *
     * @param connection - The XMPP connection
     * @param roomJid - The JID of the conference room
     */
    constructor(connection: XmppConnection, roomJid: string) {
        this._connection = connection;
        this._roomJid = roomJid;

        logger.info('TrackSubscriptionManager created for room:', roomJid);
    }

    /**
     * Sets the callback for when a new track becomes available.
     *
     * @param callback - Callback function
     */
    onTrackAvailable(callback: (trackInfo: IRemoteTrackInfo) => void): void {
        this._onTrackAvailable = callback;
    }

    /**
     * Sets the callback for when a track becomes unavailable.
     *
     * @param callback - Callback function
     */
    onTrackUnavailable(callback: (trackInfo: IRemoteTrackInfo) => void): void {
        this._onTrackUnavailable = callback;
    }

    /**
     * Requests the list of available tracks in the conference.
     *
     * @returns Promise that resolves with the list of available tracks
     */
    async requestAvailableTracks(): Promise<IRemoteTrackInfo[]> {
        logger.info('Requesting available tracks from Prosody');

        return new Promise((resolve, reject) => {
            const iq = $iq({
                to: this._roomJid,
                type: 'get'
            })
                .c('track-list', { xmlns: 'urn:xmpp:jitsi:cloudflare:tracks:0' });

            this._connection.sendIQ(
                iq.tree(),
                (result: Element) => {
                    try {
                        const tracks: IRemoteTrackInfo[] = [];
                        const trackElements = result.querySelectorAll('track');

                        trackElements.forEach(trackEl => {
                            const trackId = trackEl.querySelector('track-id')?.textContent;
                            const trackType = trackEl.querySelector('track-type')?.textContent as 'audio' | 'video';
                            const participantId = trackEl.querySelector('participant-id')?.textContent;

                            if (trackId && trackType && participantId) {
                                const trackInfo: IRemoteTrackInfo = {
                                    trackId,
                                    trackType,
                                    participantId,
                                    trackLabel: trackEl.querySelector('track-label')?.textContent || undefined,
                                    streamId: trackEl.querySelector('stream-id')?.textContent || undefined,
                                    ssrc: trackEl.querySelector('ssrc')?.textContent || undefined
                                };

                                tracks.push(trackInfo);
                                this._availableTracks.set(trackId, trackInfo);
                            }
                        });

                        logger.info('Received %d available tracks', tracks.length);
                        resolve(tracks);
                    } catch (error) {
                        logger.error('Failed to parse track list:', error);
                        reject(error);
                    }
                },
                (error: any) => {
                    logger.error('Failed to request track list:', error);
                    reject(new Error(`Failed to request tracks: ${error}`));
                },
                15000 // 15 second timeout
            );
        });
    }

    /**
     * Handles incoming track notifications from Prosody.
     *
     * @param notification - The track notification message element
     */
    handleTrackNotification(notification: Element): void {
        const action = notification.getAttribute('action');
        const trackId = notification.querySelector('track-id')?.textContent;
        const trackType = notification.querySelector('track-type')?.textContent as 'audio' | 'video';
        const participantId = notification.querySelector('participant-id')?.textContent;

        if (!trackId || !trackType || !participantId) {
            logger.warn('Invalid track notification - missing required fields');

            return;
        }

        if (action === 'add') {
            const trackInfo: IRemoteTrackInfo = {
                trackId,
                trackType,
                participantId,
                trackLabel: notification.querySelector('track-label')?.textContent || undefined,
                streamId: notification.querySelector('stream-id')?.textContent || undefined,
                ssrc: notification.querySelector('ssrc')?.textContent || undefined
            };

            this._availableTracks.set(trackId, trackInfo);
            logger.info('Track available:', trackId, trackType, participantId);

            // Notify listener
            if (this._onTrackAvailable) {
                this._onTrackAvailable(trackInfo);
            }

            // Auto-subscribe based on current policy
            this._evaluateSubscription(trackInfo);

        } else if (action === 'remove') {
            const trackInfo = this._availableTracks.get(trackId);

            if (trackInfo) {
                this._availableTracks.delete(trackId);
                this._subscribedTracks.delete(trackId);
                this._videoConstraints.delete(trackId);

                logger.info('Track unavailable:', trackId);

                // Notify listener
                if (this._onTrackUnavailable) {
                    this._onTrackUnavailable(trackInfo);
                }
            }
        }
    }

    /**
     * Evaluates whether to subscribe to a track based on current policy.
     * @private
     */
    private _evaluateSubscription(trackInfo: IRemoteTrackInfo): void {
        // Always subscribe to audio tracks
        if (trackInfo.trackType === 'audio') {
            this.subscribeToTrack(trackInfo.trackId);

            return;
        }

        // For video tracks, apply LastN-like logic
        if (trackInfo.trackType === 'video') {
            const videoTrackCount = Array.from(this._subscribedTracks).filter(tid => {
                const track = this._availableTracks.get(tid);

                return track?.trackType === 'video';
            }).length;

            // Subscribe if under the limit or if it's the dominant speaker
            if (videoTrackCount < this._maxSubscribedVideoTracks 
                || trackInfo.participantId === this._dominantSpeaker) {
                this.subscribeToTrack(trackInfo.trackId, {
                    maxHeight: 720 // Default quality
                });
            }
        }
    }

    /**
     * Subscribes to a specific track.
     *
     * @param trackId - The ID of the track to subscribe to
     * @param constraints - Optional video quality constraints
     */
    subscribeToTrack(trackId: string, constraints?: IVideoConstraints): void {
        if (this._subscribedTracks.has(trackId)) {
            logger.debug('Already subscribed to track:', trackId);

            return;
        }

        const trackInfo = this._availableTracks.get(trackId);

        if (!trackInfo) {
            logger.warn('Cannot subscribe to unknown track:', trackId);

            return;
        }

        this._subscribedTracks.add(trackId);

        if (constraints && trackInfo.trackType === 'video') {
            this._videoConstraints.set(trackId, constraints);
        }

        logger.info('Subscribed to track:', trackId, constraints);

        // In actual implementation, this would trigger Cloudflare SFU subscription
        // via the CloudflarePeerConnection
    }

    /**
     * Unsubscribes from a specific track.
     *
     * @param trackId - The ID of the track to unsubscribe from
     */
    unsubscribeFromTrack(trackId: string): void {
        if (!this._subscribedTracks.has(trackId)) {
            logger.debug('Not subscribed to track:', trackId);

            return;
        }

        this._subscribedTracks.delete(trackId);
        this._videoConstraints.delete(trackId);

        logger.info('Unsubscribed from track:', trackId);

        // In actual implementation, this would trigger Cloudflare SFU unsubscription
        // via the CloudflarePeerConnection
    }

    /**
     * Sets the maximum number of video tracks to subscribe to (LastN equivalent).
     *
     * @param maxTracks - Maximum number of video tracks
     */
    setMaxSubscribedVideoTracks(maxTracks: number): void {
        this._maxSubscribedVideoTracks = maxTracks;
        logger.info('Max subscribed video tracks set to:', maxTracks);

        // Re-evaluate subscriptions
        this._reEvaluateAllSubscriptions();
    }

    /**
     * Sets video quality constraints for a specific track.
     *
     * @param trackId - The ID of the track
     * @param constraints - Video quality constraints
     */
    setVideoConstraints(trackId: string, constraints: IVideoConstraints): void {
        if (!this._subscribedTracks.has(trackId)) {
            logger.warn('Cannot set constraints for unsubscribed track:', trackId);

            return;
        }

        this._videoConstraints.set(trackId, constraints);
        logger.info('Video constraints set for track:', trackId, constraints);

        // In actual implementation, this would update the Cloudflare SFU subscription
    }

    /**
     * Updates the dominant speaker.
     *
     * @param participantId - The ID of the dominant speaker
     */
    setDominantSpeaker(participantId: string | null): void {
        this._dominantSpeaker = participantId;
        logger.debug('Dominant speaker updated:', participantId);

        // Re-evaluate subscriptions to prioritize dominant speaker
        this._reEvaluateAllSubscriptions();
    }

    /**
     * Re-evaluates all track subscriptions based on current policy.
     * @private
     */
    private _reEvaluateAllSubscriptions(): void {
        // Get all video tracks
        const videoTracks = Array.from(this._availableTracks.values())
            .filter(t => t.trackType === 'video');

        // Prioritize dominant speaker
        const prioritized = videoTracks.sort((a, b) => {
            if (a.participantId === this._dominantSpeaker) {
                return -1;
            }
            if (b.participantId === this._dominantSpeaker) {
                return 1;
            }

            return 0;
        });

        // Subscribe to top N tracks
        const toSubscribe = prioritized.slice(0, this._maxSubscribedVideoTracks);
        const toUnsubscribe = prioritized.slice(this._maxSubscribedVideoTracks);

        toSubscribe.forEach(track => {
            if (!this._subscribedTracks.has(track.trackId)) {
                this.subscribeToTrack(track.trackId, { maxHeight: 720 });
            }
        });

        toUnsubscribe.forEach(track => {
            if (this._subscribedTracks.has(track.trackId)) {
                this.unsubscribeFromTrack(track.trackId);
            }
        });
    }

    /**
     * Gets all available tracks.
     *
     * @returns Array of available track info
     */
    getAvailableTracks(): IRemoteTrackInfo[] {
        return Array.from(this._availableTracks.values());
    }

    /**
     * Gets all subscribed track IDs.
     *
     * @returns Set of subscribed track IDs
     */
    getSubscribedTracks(): Set<string> {
        return new Set(this._subscribedTracks);
    }

    /**
     * Checks if a track is subscribed.
     *
     * @param trackId - The track ID to check
     * @returns True if subscribed
     */
    isSubscribed(trackId: string): boolean {
        return this._subscribedTracks.has(trackId);
    }

    /**
     * Cleans up resources.
     */
    dispose(): void {
        logger.info('Disposing TrackSubscriptionManager');
        this._availableTracks.clear();
        this._subscribedTracks.clear();
        this._videoConstraints.clear();
        this._onTrackAvailable = undefined;
        this._onTrackUnavailable = undefined;
    }
}

