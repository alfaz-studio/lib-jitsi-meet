import { $iq, Strophe } from 'strophe.js';
import { getLogger } from '@jitsi/logger';

import { ICloudflareSessionInfo } from '../RTC/CloudflarePeerConnection';
import type XmppConnection from '../xmpp/XmppConnection';

const logger = getLogger('cloudflare:SessionManager');

/**
 * CloudflareSessionManager handles requesting and managing Cloudflare SFU session information
 * from the Prosody XMPP server via IQ stanzas.
 */
export default class CloudflareSessionManager {
    private _connection: XmppConnection;
    private _roomJid: string;
    private _domain: string;
    private _sessionInfo: ICloudflareSessionInfo | null = null;

    /**
     * Creates a new CloudflareSessionManager instance.
     *
     * @param connection - The XMPP connection
     * @param roomJid - The JID of the conference room
     */
    constructor(connection: XmppConnection, roomJid: string) {
        this._connection = connection;
        this._roomJid = roomJid;

        // Extract main domain from room JID (e.g., conference.staj.sonacove.com -> staj.sonacove.com)
        const roomDomain = Strophe.getDomainFromJid(roomJid) || '';

        // Remove "conference." prefix if present to get main domain
        this._domain = roomDomain.replace(/^conference\./, '');

        logger.info('CloudflareSessionManager created for room:', roomJid, 'domain:', this._domain);
    }

    /**
     * Requests a Cloudflare SFU session from Prosody.
     *
     * @returns Promise that resolves with session information
     */
    async requestSession(): Promise<ICloudflareSessionInfo> {
        if (this._sessionInfo) {
            logger.info('Returning cached Cloudflare session:', this._sessionInfo.sessionId);

            return this._sessionInfo;
        }

        logger.info('Requesting Cloudflare SFU session from Prosody for room:', this._roomJid);

        return new Promise((resolve, reject) => {
            // Create IQ stanza to request Cloudflare session
            // Send to the main domain where mod_cloudflare_session is loaded
            // Include room JID in the query so Prosody knows which room
            const iq = $iq({
                to: this._domain,
                type: 'get'
            })
                .c('cloudflare-session', {
                    xmlns: 'urn:xmpp:jitsi:cloudflare:0',
                    room: this._roomJid
                });

            // Send IQ request
            this._connection.sendIQ(
                iq.tree(),
                (result: Element) => {
                    try {
                        // Parse the response
                        const sessionElement = result.querySelector('cloudflare-session');

                        if (!sessionElement) {
                            logger.error('No cloudflare-session element in response');
                            reject(new Error('Invalid response format'));

                            return;
                        }

                        const sessionIdEl = sessionElement.querySelector('session-id');
                        const tokenEl = sessionElement.querySelector('token');
                        const apiUrlEl = sessionElement.querySelector('api-url');
                        const appIdEl = sessionElement.querySelector('app-id');

                        if (!sessionIdEl || !tokenEl) {
                            logger.error('Missing required session fields in response');
                            reject(new Error('Missing session-id or token'));

                            return;
                        }

                        this._sessionInfo = {
                            sessionId: sessionIdEl.textContent || '',
                            token: tokenEl.textContent || '',
                            apiUrl: apiUrlEl?.textContent || '',
                            appId: appIdEl?.textContent || ''
                        };

                        logger.info('Cloudflare session received:', this._sessionInfo.sessionId);
                        resolve(this._sessionInfo);
                    } catch (error) {
                        logger.error('Failed to parse Cloudflare session response:', error);
                        reject(error);
                    }
                },
                (error: any) => {
                    // Try to extract error details from the IQ error response
                    let errorDetails = String(error);

                    if (error instanceof Element) {
                        const errorEl = error.querySelector('error');

                        if (errorEl) {
                            const errorType = errorEl.getAttribute('type') || 'unknown';
                            const errorCode = errorEl.getAttribute('code') || '';
                            // Get the first child element name which indicates the error condition
                            const errorCondition = errorEl.firstElementChild?.tagName || 'unknown';
                            const errorText = errorEl.querySelector('text')?.textContent || '';

                            errorDetails = `type=${errorType}, code=${errorCode}, condition=${errorCondition}, text=${errorText}`;
                        }
                    }
                    logger.error('Failed to request Cloudflare session. Error details:', errorDetails);
                    reject(new Error(`Failed to request session: ${errorDetails}`));
                },
                30000 // 30 second timeout
            );
        });
    }

    /**
     * Gets the cached session info if available.
     *
     * @returns The cached session info or null
     */
    getSessionInfo(): ICloudflareSessionInfo | null {
        return this._sessionInfo;
    }

    /**
     * Clears the cached session information.
     */
    clearSession(): void {
        logger.info('Clearing Cloudflare session');
        this._sessionInfo = null;
    }

    /**
     * Checks if a session is currently active.
     *
     * @returns True if a session exists
     */
    hasSession(): boolean {
        return this._sessionInfo !== null;
    }
}

