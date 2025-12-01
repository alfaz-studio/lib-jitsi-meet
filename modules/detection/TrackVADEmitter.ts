import RTC from '../RTC/RTC';
import EventEmitter from '../util/EventEmitter';
import { createAudioContext } from '../webaudio/WebAudioUtils';

import { DetectionEvents } from './DetectionEvents';
import type { IVADProcessor } from './VADAudioAnalyser';

// Import the worklet URL using Vite's worker URL syntax
import workletUrl from './VADWorkletProcessor?worker&url';

/**
 * Message types received from the VAD worklet.
 */
interface VADWorkletPCMMessage {
    type: 'pcm';
    pcmData: Float32Array;
    timestamp: number;
}

/**
 * Connects an audio JitsiLocalTrack to a vadProcessor using WebAudio AudioWorkletNode.
 * Once an object is created audio from the local track flows through the AudioWorkletNode as raw PCM.
 * The PCM is processed by the injected vad module and a voice activity detection score is obtained, the
 * score is published to consumers via an EventEmitter.
 * After work is done with this service the destroy method needs to be called for a proper cleanup.
 *
 * @fires VAD_SCORE_PUBLISHED
 */
export default class TrackVADEmitter extends EventEmitter {
    /**
     * VAD Processor that allows us to calculate VAD score for PCM samples.
     */
    private _vadProcessor: IVADProcessor;

    /**
     * The JitsiLocalTrack instance.
     */
    private _localTrack: any; // JitsiLocalTrack type

    /**
     * The AudioContext instance with the preferred sample frequency.
     */
    private _audioContext: AudioContext | undefined;

    /**
     * PCM Sample size expected by the VAD Processor instance.
     */
    private _vadSampleSize: number;

    /**
     * MediaStreamAudioSourceNode connected to the local track's stream.
     */
    private _audioSource: MediaStreamAudioSourceNode | undefined;

    /**
     * AudioWorkletNode that processes audio in a separate thread.
     */
    private _audioWorkletNode: AudioWorkletNode | undefined;

    /**
     * Flag indicating whether the audio worklet has been initialized.
     */
    private _workletInitialized = false;

    /**
     * Promise that resolves when the worklet is ready.
     */
    private _workletReadyPromise: Promise<void> | undefined;

    /**
     * Flag indicating whether this instance has been destroyed.
     */
    private _destroyed = false;

    /**
     * Bound message handler for worklet messages.
     */
    private _onWorkletMessage: (event: MessageEvent<VADWorkletPCMMessage>) => void;

    /**
     * Constructor.
     *
     * @param vadProcessor - VAD processor that allows us to calculate VAD score for PCM samples.
     * @param jitsiLocalTrack - JitsiLocalTrack corresponding to micDeviceId.
     */
    constructor(vadProcessor: IVADProcessor, jitsiLocalTrack: any) {
        super();

        this._vadProcessor = vadProcessor;
        this._localTrack = jitsiLocalTrack;
        this._vadSampleSize = vadProcessor.getSampleLength();
        this._audioContext = createAudioContext({ sampleRate: vadProcessor.getRequiredPCMFrequency() });

        this._onWorkletMessage = this._handleWorkletMessage.bind(this);
    }

    /**
     * Factory method that sets up all the necessary components for the creation of the TrackVADEmitter.
     *
     * @param micDeviceId - Target microphone device id.
     * @param _procNodeSampleRate - Sample rate of the proc node (deprecated, kept for API compatibility).
     * @param vadProcessor - Module that calculates the voice activity score for a certain audio PCM sample.
     * The processor needs to implement the following functions:
     * - `getSampleLength()` - Returns the sample size accepted by calculateAudioFrameVAD.
     * - `getRequiredPCMFrequency()` - Returns the PCM frequency at which the processor operates.
     * - `calculateAudioFrameVAD(pcmSample)` - Process a 32 float pcm sample of getSampleLength size.
     * @returns Promise resolving in a new instance of TrackVADEmitter.
     */
    static async create(
            micDeviceId: string,
            _procNodeSampleRate: number,
            vadProcessor: IVADProcessor
    ): Promise<TrackVADEmitter> {
        const localTracks = await RTC.obtainAudioAndVideoPermissions({
            devices: [ 'audio' ],
            micDeviceId
        });

        // We only expect one audio track when specifying a device id.
        if (!localTracks[0]) {
            throw new Error(`Failed to create jitsi local track for device id: ${micDeviceId}`);
        }

        const emitter = new TrackVADEmitter(vadProcessor, localTracks[0]);

        // Initialize the audio worklet
        await emitter._initializeAudioWorklet();

        return emitter;
    }

    /**
     * Initialize the AudioWorklet by loading the processor module.
     *
     * @returns Promise that resolves when the worklet is ready.
     */
    private async _initializeAudioWorklet(): Promise<void> {
        if (this._workletReadyPromise) {
            return this._workletReadyPromise;
        }

        this._workletReadyPromise = this._doInitializeAudioWorklet();

        return this._workletReadyPromise;
    }

    /**
     * Internal method to initialize the audio worklet.
     *
     * @returns Promise that resolves when initialization is complete.
     */
    private async _doInitializeAudioWorklet(): Promise<void> {
        if (!this._audioContext) {
            throw new Error('AudioContext not available');
        }

        // Ensure the audio context is running
        if (this._audioContext.state === 'suspended') {
            await this._audioContext.resume();
        }

        // Load the worklet module
        await this._audioContext.audioWorklet.addModule(workletUrl);

        // Create the audio source from the local track's stream
        this._audioSource = this._audioContext.createMediaStreamSource(this._localTrack.stream);

        // Create the AudioWorkletNode
        this._audioWorkletNode = new AudioWorkletNode(this._audioContext, 'VADWorkletProcessor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            channelCount: 1,
            channelCountMode: 'explicit',
            channelInterpretation: 'speakers'
        });

        // Set up message handler for receiving PCM data from the worklet
        this._audioWorkletNode.port.onmessage = this._onWorkletMessage;

        // Send initialization message to the worklet with VAD sample size
        this._audioWorkletNode.port.postMessage({
            type: 'init',
            vadSampleSize: this._vadSampleSize
        });

        this._workletInitialized = true;
    }

    /**
     * Handle messages from the audio worklet.
     *
     * @param event - MessageEvent containing PCM data from the worklet.
     * @fires VAD_SCORE_PUBLISHED
     */
    private _handleWorkletMessage(event: MessageEvent<VADWorkletPCMMessage>): void {
        if (this._destroyed) {
            return;
        }

        const { type, pcmData, timestamp } = event.data;

        if (type !== 'pcm') {
            return;
        }

        // Calculate VAD score on the main thread
        // The VAD processor might change the values inside the array so we make a copy
        const vadScore = this._vadProcessor.calculateAudioFrameVAD(pcmData.slice());

        this.emit(DetectionEvents.VAD_SCORE_PUBLISHED, {
            deviceId: this._localTrack.getDeviceId(),
            pcmData,
            score: vadScore,
            timestamp
        });
    }

    /**
     * Connects the nodes in the AudioContext to start the flow of audio data.
     */
    private _connectAudioGraph(): void {
        if (!this._audioSource || !this._audioWorkletNode || !this._audioContext) {
            return;
        }

        this._audioSource.connect(this._audioWorkletNode);

        // Connect to destination to keep the audio graph alive
        // The worklet doesn't modify audio, it just observes it
        this._audioWorkletNode.connect(this._audioContext.destination);
    }

    /**
     * Disconnects the nodes in the AudioContext.
     */
    private _disconnectAudioGraph(): void {
        if (this._audioWorkletNode) {
            this._audioWorkletNode.disconnect();
        }
        if (this._audioSource) {
            this._audioSource.disconnect();
        }
    }

    /**
     * Cleanup potentially acquired resources.
     */
    private _cleanupResources(): void {
        // Tell the worklet to stop processing
        if (this._audioWorkletNode) {
            this._audioWorkletNode.port.postMessage({ type: 'stop' });
            this._audioWorkletNode.port.close();
        }

        this._disconnectAudioGraph();
        this._localTrack.stopStream();
    }

    /**
     * Get the associated track device ID.
     *
     * @returns The device ID of the track.
     */
    getDeviceId(): string {
        return this._localTrack.getDeviceId();
    }

    /**
     * Get the associated track label.
     *
     * @returns The device label of the track.
     */
    getTrackLabel(): string {
        return this._localTrack.getDeviceLabel();
    }

    /**
     * Start the emitter by connecting the audio graph.
     */
    start(): void {
        if (!this._workletInitialized) {
            console.warn('TrackVADEmitter: Cannot start before worklet is initialized');

            return;
        }
        this._connectAudioGraph();
    }

    /**
     * Stops the emitter by disconnecting the audio graph.
     */
    stop(): void {
        this._disconnectAudioGraph();
    }

    /**
     * Destroy TrackVADEmitter instance (release resources and stop callbacks).
     */
    destroy(): void {
        if (this._destroyed) {
            return;
        }

        this._cleanupResources();
        this._destroyed = true;
    }
}

