export enum ConnectionQualityEvents {

    /**
     * Indicates that the local connection statistics were updated.
     */
    LOCAL_STATS_UPDATED = 'cq.local_stats_updated',

    /**
     * Indicates that the connection statistics for a particular remote participant
     * were updated.
     */
    REMOTE_STATS_UPDATED = 'cq.remote_stats_updated',

    /**
     * Indicates that video upload bitrate has been zero for consecutive samples
     * while an active local video track exists and audio is still flowing.
     * This suggests the video encoding may be stuck (e.g., due to stale
     * constraints sent during a network interruption).
     */
    VIDEO_ZERO_MEDIA_DETECTED = 'cq.video_zero_media_detected'
}
