/**
 * Audio Worklet Processor for Voice Activity Detection (VAD).
 *
 * This processor runs in a separate audio thread and buffers incoming PCM samples.
 * When enough samples are accumulated (matching the VAD processor's expected sample size),
 * it sends the PCM data to the main thread via MessagePort for VAD score calculation.
 *
 * The worklet operates with a fixed input size of 128 samples per process() call,
 * so we buffer until we have enough samples for the VAD processor.
 */

/**
 * Message types sent from main thread to worklet.
 */
interface VADWorkletInitMessage {
    type: 'init';
    vadSampleSize: number;
}

interface VADWorkletStopMessage {
    type: 'stop';
}

type VADWorkletIncomingMessage = VADWorkletInitMessage | VADWorkletStopMessage;

/**
 * Message types sent from worklet to main thread.
 */
interface VADWorkletPCMMessage {
    type: 'pcm';
    pcmData: Float32Array;
    timestamp: number;
}

class VADWorkletProcessor extends AudioWorkletProcessor {
    /**
     * PCM Sample size expected by the VAD processor.
     */
    private _vadSampleSize = 0;

    /**
     * Buffer to accumulate PCM samples until we have enough for VAD processing.
     */
    private _buffer: Float32Array = new Float32Array(0);

    /**
     * Current write position in the buffer.
     */
    private _bufferWriteIndex = 0;

    /**
     * Flag indicating whether the processor has been initialized with VAD sample size.
     */
    private _initialized = false;

    /**
     * Flag indicating whether the processor should continue processing.
     */
    private _active = true;

    /**
     * Constructor - sets up message handler for initialization.
     */
    constructor() {
        super();

        this.port.onmessage = (event: MessageEvent<VADWorkletIncomingMessage>) => {
            this._handleMessage(event.data);
        };
    }

    /**
     * Handle messages from the main thread.
     *
     * @param message - The message from the main thread.
     */
    private _handleMessage(message: VADWorkletIncomingMessage): void {
        switch (message.type) {
        case 'init':
            this._vadSampleSize = message.vadSampleSize;

            // Allocate buffer large enough to hold samples
            // We use 2x the VAD sample size to handle cases where we accumulate
            // samples across multiple process() calls
            this._buffer = new Float32Array(this._vadSampleSize * 2);
            this._bufferWriteIndex = 0;
            this._initialized = true;
            break;

        case 'stop':
            this._active = false;
            break;
        }
    }

    /**
     * Process audio data. Called by the audio rendering thread for each audio block.
     *
     * @param inputs - Array of inputs, each containing channels of audio data.
     * @param _outputs - Array of outputs (unused, we don't modify audio).
     * @returns True to keep the processor alive, false to terminate.
     */
    process(inputs: Float32Array[][], _outputs: Float32Array[][]): boolean {
        if (!this._active) {
            return false;
        }

        if (!this._initialized) {
            // Not yet initialized, wait for init message
            return true;
        }

        // Get the first channel of the first input
        const input = inputs[0]?.[0];

        if (!input || input.length === 0) {
            // No input data, continue processing
            return true;
        }

        // Copy input samples to our buffer
        this._buffer.set(input, this._bufferWriteIndex);
        this._bufferWriteIndex += input.length;

        // Check if we have enough samples for VAD processing
        while (this._bufferWriteIndex >= this._vadSampleSize) {
            // Extract the samples for VAD processing
            const pcmData = this._buffer.slice(0, this._vadSampleSize);

            // Send PCM data to main thread for VAD calculation
            const message: VADWorkletPCMMessage = {
                type: 'pcm',
                pcmData,

                // currentTime is in seconds, convert to milliseconds for consistency
                // Note: currentTime is available in AudioWorkletGlobalScope
                timestamp: Date.now()
            };

            this.port.postMessage(message, [ pcmData.buffer ]);

            // Shift remaining samples to the beginning of the buffer
            const remaining = this._bufferWriteIndex - this._vadSampleSize;

            if (remaining > 0) {
                // Copy remaining samples to the start of the buffer
                this._buffer.copyWithin(0, this._vadSampleSize, this._bufferWriteIndex);
            }
            this._bufferWriteIndex = remaining;
        }

        return true;
    }
}

registerProcessor('VADWorkletProcessor', VADWorkletProcessor);

