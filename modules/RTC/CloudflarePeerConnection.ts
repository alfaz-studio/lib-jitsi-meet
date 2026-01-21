import { getLogger } from '@jitsi/logger';

import { MediaType } from '../../service/RTC/MediaType';
import { RTCEvents } from '../../service/RTC/RTCEvents';
import EventEmitter from '../util/EventEmitter';

import JitsiLocalTrack from './JitsiLocalTrack';
import JitsiRemoteTrack from './JitsiRemoteTrack';
import RTC from './RTC';

const logger = getLogger('rtc:CloudflarePeerConnection');

/**
 * Interface for Cloudflare session info received from Prosody
 */
export interface ICloudflareSessionInfo {
    sessionId: string;
    token: string;
    apiUrl: string;
    appId: string;
}

/**
 * Options for CloudflarePeerConnection
 */
export interface ICloudflareOptions {
    enableInsertableStreams?: boolean;
    startSilent?: boolean;
}

/**
 * CloudflarePeerConnection manages the WebRTC connection to Cloudflare SFU.
 * This replaces JingleSessionPC and TraceablePeerConnection for Cloudflare-based media routing.
 */
export default class CloudflarePeerConnection {
    private _peerConnection: RTCPeerConnection | null = null;
    private _sessionInfo: ICloudflareSessionInfo | null = null;
    private _localTracks: Map<string, JitsiLocalTrack> = new Map();
    private _remoteTracks: Map<string, JitsiRemoteTrack> = new Map();
    private _eventEmitter: EventEmitter;
    private _rtc: RTC;
    private _options: ICloudflareOptions;
    private _iceServers: RTCIceServer[] = [];
    private _id: number;
    private _closed: boolean = false;

    // Public properties
    public isP2P: boolean = false; // Cloudflare SFU is never P2P
    public remoteTracks: Map<string, Map<MediaType, Set<JitsiRemoteTrack>>>;

    /**
     * Creates a new CloudflarePeerConnection instance.
     *
     * @param rtc - The RTC instance that owns this connection
     * @param id - Unique identifier for this peer connection
     * @param eventEmitter - Event emitter for signaling events
     * @param iceServers - Array of ICE servers (TURN/STUN) from Cloudflare
     * @param options - Configuration options
     */
    constructor(
        rtc: RTC,
        id: number,
        eventEmitter: EventEmitter,
        iceServers: RTCIceServer[],
        options: ICloudflareOptions = {}
    ) {
        this._rtc = rtc;
        this._id = id;
        this._eventEmitter = eventEmitter;
        this._iceServers = iceServers;
        this._options = options;
        this.remoteTracks = new Map();

        logger.info(`CloudflarePeerConnection created with id: ${id}`);
    }

    /**
     * Gets the unique ID of this peer connection.
     */
    get id(): number {
        return this._id;
    }

    /**
     * Gets the underlying RTCPeerConnection.
     */
    get peerconnection(): RTCPeerConnection | null {
        return this._peerConnection;
    }

    /**
     * Gets the Cloudflare session info.
     */
    get sessionInfo(): ICloudflareSessionInfo | null {
        return this._sessionInfo;
    }

    /**
     * Initializes the peer connection with Cloudflare session info.
     *
     * @param sessionInfo - Session information from Prosody module
     * @returns Promise that resolves when initialization is complete
     */
    async initialize(sessionInfo: ICloudflareSessionInfo): Promise<void> {
        if (this._peerConnection) {
            logger.warn('Peer connection already initialized');

            return;
        }

        this._sessionInfo = sessionInfo;

        logger.info('Initializing CloudflarePeerConnection with session:', sessionInfo.sessionId);

        // Build RTCConfiguration
        const pcConfig: RTCConfiguration = {
            iceServers: this._iceServers,
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        };

        // Enable insertable streams for E2EE if requested
        if (this._options.enableInsertableStreams) {
            logger.info('E2EE - enabling insertable streams for Cloudflare connection');
            pcConfig.encodedInsertableStreams = true;
        }

        try {
            // Create the peer connection
            this._peerConnection = new RTCPeerConnection(pcConfig);

            // Set up event handlers
            this._setupEventHandlers();

            logger.info('CloudflarePeerConnection initialized successfully');
        } catch (error) {
            logger.error('Failed to create RTCPeerConnection:', error);
            throw error;
        }
    }

    /**
     * Sets up event handlers for the peer connection.
     * @private
     */
    private _setupEventHandlers(): void {
        if (!this._peerConnection) {
            return;
        }

        // ICE candidate event
        this._peerConnection.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
            if (event.candidate) {
                logger.debug('ICE candidate generated:', event.candidate.candidate);
                this._eventEmitter.emit(RTCEvents.ICE_CANDIDATE, this, event.candidate);
            } else {
                logger.info('ICE gathering complete');
            }
        };

        // ICE connection state change
        this._peerConnection.oniceconnectionstatechange = () => {
            const state = this._peerConnection?.iceConnectionState;

            logger.info('ICE connection state changed:', state);
            this._eventEmitter.emit(RTCEvents.ICE_CONNECTION_STATE_CHANGED, this, state);

            if (state === 'failed') {
                logger.error('ICE connection failed');
                this._eventEmitter.emit(RTCEvents.ICE_FAILED, this);
            } else if (state === 'connected' || state === 'completed') {
                logger.info('ICE connection established');
                this._eventEmitter.emit(RTCEvents.ICE_CONNECTED, this);
            }
        };

        // Connection state change
        this._peerConnection.onconnectionstatechange = () => {
            const state = this._peerConnection?.connectionState;

            logger.info('Connection state changed:', state);

            if (state === 'connected') {
                logger.info('Peer connection established');
            } else if (state === 'failed' || state === 'closed') {
                logger.warn('Peer connection failed or closed:', state);
            }
        };

        // Track event - remote track received
        this._peerConnection.ontrack = (event: RTCTrackEvent) => {
            logger.info('Remote track received:', {
                kind: event.track.kind,
                id: event.track.id,
                streams: event.streams.length
            });

            this._handleRemoteTrack(event);
        };

        // Data channel event (if Cloudflare supports it)
        this._peerConnection.ondatachannel = (event: RTCDataChannelEvent) => {
            logger.info('Data channel received:', event.channel.label);
            // Handle data channel if needed
        };
    }

    /**
     * Handles incoming remote tracks from Cloudflare SFU.
     * @private
     */
    private _handleRemoteTrack(event: RTCTrackEvent): void {
        const { track, streams } = event;
        const stream = streams[0];

        if (!stream) {
            logger.warn('Remote track received without stream');

            return;
        }

        // Extract participant ID and media type from stream ID or track ID
        // This will depend on how Cloudflare SFU structures stream IDs
        const mediaType = track.kind === 'video' ? MediaType.VIDEO : MediaType.AUDIO;
        const streamId = stream.id;

        // Create or get existing remote track
        let remoteTrack = this._remoteTracks.get(track.id);

        if (!remoteTrack) {
            // Create JitsiRemoteTrack
            remoteTrack = new JitsiRemoteTrack(
                this._rtc,
                this._rtc.conference,
                streamId, // ownerEndpointId - will be parsed from stream
                stream,
                track,
                mediaType,
                0, // videoType - will be determined
                [] // ssrc list
            );

            this._remoteTracks.set(track.id, remoteTrack);

            // Organize by participant and media type
            if (!this.remoteTracks.has(streamId)) {
                this.remoteTracks.set(streamId, new Map());
            }

            const participantTracks = this.remoteTracks.get(streamId);

            if (!participantTracks?.has(mediaType)) {
                participantTracks?.set(mediaType, new Set());
            }

            participantTracks?.get(mediaType)?.add(remoteTrack);

            // Emit event for new remote track
            this._eventEmitter.emit(RTCEvents.REMOTE_TRACK_ADDED, remoteTrack, this);
            logger.info('Remote track added:', { trackId: track.id, streamId, mediaType });
        }

        // Handle track ended
        track.onended = () => {
            logger.info('Remote track ended:', track.id);
            this._removeRemoteTrack(track.id);
        };

        track.onmute = () => {
            logger.debug('Remote track muted:', track.id);
            remoteTrack?.setMute(true);
        };

        track.onunmute = () => {
            logger.debug('Remote track unmuted:', track.id);
            remoteTrack?.setMute(false);
        };
    }

    /**
     * Removes a remote track.
     * @private
     */
    private _removeRemoteTrack(trackId: string): void {
        const remoteTrack = this._remoteTracks.get(trackId);

        if (remoteTrack) {
            this._remoteTracks.delete(trackId);
            this._eventEmitter.emit(RTCEvents.REMOTE_TRACK_REMOVED, remoteTrack, this);
            logger.info('Remote track removed:', trackId);
        }
    }

    /**
     * Adds a local track to the peer connection.
     *
     * @param track - The local track to add
     * @returns Promise that resolves when the track is added
     */
    async addTrack(track: JitsiLocalTrack): Promise<void> {
        if (!this._peerConnection) {
            throw new Error('Peer connection not initialized');
        }

        if (this._closed) {
            throw new Error('Peer connection is closed');
        }

        const mediaType = track.getType();
        const trackId = track.getId();

        logger.info('Adding local track:', { trackId, mediaType });

        // Check if already added
        if (this._localTracks.has(trackId)) {
            logger.warn('Track already added:', trackId);

            return;
        }

        try {
            const webrtcTrack = track.getTrack();
            const stream = track.getOriginalStream();

            // Add track to peer connection
            const sender = this._peerConnection.addTrack(webrtcTrack, stream);

            logger.info('Track added to peer connection:', {
                trackId,
                mediaType,
                senderId: sender.track?.id
            });

            // Store the track
            this._localTracks.set(trackId, track);

            // Trigger negotiation
            await this._negotiate();
        } catch (error) {
            logger.error('Failed to add track:', error);
            throw error;
        }
    }

    /**
     * Removes a local track from the peer connection.
     *
     * @param track - The local track to remove
     * @returns Promise that resolves when the track is removed
     */
    async removeTrack(track: JitsiLocalTrack): Promise<void> {
        if (!this._peerConnection) {
            throw new Error('Peer connection not initialized');
        }

        const trackId = track.getId();

        logger.info('Removing local track:', trackId);

        // Check if track exists
        if (!this._localTracks.has(trackId)) {
            logger.warn('Track not found:', trackId);

            return;
        }

        try {
            const webrtcTrack = track.getTrack();

            // Find the sender for this track
            const sender = this._peerConnection.getSenders().find(s => s.track === webrtcTrack);

            if (sender) {
                this._peerConnection.removeTrack(sender);
                logger.info('Track removed from peer connection:', trackId);
            }

            // Remove from local tracks
            this._localTracks.delete(trackId);

            // Trigger negotiation
            await this._negotiate();
        } catch (error) {
            logger.error('Failed to remove track:', error);
            throw error;
        }
    }

    /**
     * Performs SDP negotiation with Cloudflare SFU.
     * @private
     */
    private async _negotiate(): Promise<void> {
        if (!this._peerConnection || !this._sessionInfo) {
            throw new Error('Peer connection not initialized');
        }

        logger.info('Starting SDP negotiation');

        try {
            // Create offer
            const offer = await this._peerConnection.createOffer();

            logger.debug('Offer created:', offer.sdp);

            // Set local description
            await this._peerConnection.setLocalDescription(offer);

            logger.info('Local description set');

            // Signal the offer via XMPP
            // This will be handled by the integration layer
            this._eventEmitter.emit(RTCEvents.OFFER_CREATED, this, offer);

        } catch (error) {
            logger.error('Negotiation failed:', error);
            throw error;
        }
    }

    /**
     * Sets the remote description (answer from Cloudflare SFU).
     *
     * @param answer - The SDP answer from Cloudflare
     * @returns Promise that resolves when the answer is set
     */
    async setRemoteDescription(answer: RTCSessionDescriptionInit): Promise<void> {
        if (!this._peerConnection) {
            throw new Error('Peer connection not initialized');
        }

        logger.info('Setting remote description');

        try {
            await this._peerConnection.setRemoteDescription(answer);
            logger.info('Remote description set successfully');
        } catch (error) {
            logger.error('Failed to set remote description:', error);
            throw error;
        }
    }

    /**
     * Adds an ICE candidate received from signaling.
     *
     * @param candidate - The ICE candidate to add
     * @returns Promise that resolves when the candidate is added
     */
    async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
        if (!this._peerConnection) {
            throw new Error('Peer connection not initialized');
        }

        try {
            await this._peerConnection.addIceCandidate(candidate);
            logger.debug('ICE candidate added');
        } catch (error) {
            logger.error('Failed to add ICE candidate:', error);
            // Don't throw - ICE candidate failures are often non-fatal
        }
    }

    /**
     * Gets the connection statistics.
     *
     * @returns Promise that resolves with the stats report
     */
    async getStats(): Promise<RTCStatsReport> {
        if (!this._peerConnection) {
            throw new Error('Peer connection not initialized');
        }

        return this._peerConnection.getStats();
    }

    /**
     * Gets all local tracks.
     *
     * @returns Array of local tracks
     */
    getLocalTracks(): JitsiLocalTrack[] {
        return Array.from(this._localTracks.values());
    }

    /**
     * Gets all remote tracks.
     *
     * @returns Array of remote tracks
     */
    getRemoteTracks(): JitsiRemoteTrack[] {
        return Array.from(this._remoteTracks.values());
    }

    /**
     * Checks if the connection is active.
     *
     * @returns True if connection is active
     */
    isActive(): boolean {
        const state = this._peerConnection?.connectionState;

        return state === 'connected' || state === 'connecting';
    }

    /**
     * Closes the peer connection and cleans up resources.
     */
    close(): void {
        if (this._closed) {
            logger.warn('Peer connection already closed');

            return;
        }

        logger.info('Closing CloudflarePeerConnection');

        this._closed = true;

        // Remove all remote tracks
        for (const trackId of this._remoteTracks.keys()) {
            this._removeRemoteTrack(trackId);
        }

        // Clear local tracks
        this._localTracks.clear();

        // Close peer connection
        if (this._peerConnection) {
            this._peerConnection.close();
            this._peerConnection = null;
        }

        logger.info('CloudflarePeerConnection closed');
    }

    /**
     * Returns a string representation of this peer connection.
     */
    toString(): string {
        return `CloudflarePeerConnection[id=${this._id}, session=${this._sessionInfo?.sessionId || 'none'}]`;
    }
}

