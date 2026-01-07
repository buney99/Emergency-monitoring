export class AudioEngine {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private microphone: MediaStreamAudioSourceNode | null = null;
  private dataArray: Uint8Array | null = null;
  private stream: MediaStream | null = null;
  private keepAliveOscillator: OscillatorNode | null = null;
  
  // Circular Buffer for Time-Shift Recording
  private scriptProcessor: ScriptProcessorNode | null = null;
  private circularBuffer: Float32Array | null = null;
  private writeIndex: number = 0;
  private bufferLength: number = 0; // Total samples in buffer
  private bufferDurationSeconds: number = 5; // Keep last 5 seconds
  private sampleRate: number = 44100;

  async init(stream: MediaStream) {
    if (this.audioContext) {
        this.close();
    }

    this.stream = stream;
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    this.sampleRate = this.audioContext.sampleRate;
    
    // 1. Setup Analyser (Visuals & Trigger)
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512; 
    this.analyser.smoothingTimeConstant = 0.2;
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

    this.microphone = this.audioContext.createMediaStreamSource(stream);
    this.microphone.connect(this.analyser);

    // 2. Setup Circular Buffer (Always Recording)
    // Buffer size = sampleRate * duration
    this.bufferLength = this.sampleRate * this.bufferDurationSeconds;
    this.circularBuffer = new Float32Array(this.bufferLength);
    this.writeIndex = 0;

    // Use ScriptProcessor for raw data access (Works on older devices too)
    // BufferSize 4096 gives good balance between performance and latency
    this.scriptProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
    
    this.scriptProcessor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        
        // Write to circular buffer
        for (let i = 0; i < inputData.length; i++) {
            if (this.circularBuffer) {
                this.circularBuffer[this.writeIndex] = inputData[i];
                this.writeIndex = (this.writeIndex + 1) % this.bufferLength;
            }
        }
    };

    // Connect script processor for recording
    // We connect mic -> scriptProcessor -> muteGain -> destination
    // This ensures the processing loop runs.
    const zeroGain = this.audioContext.createGain();
    zeroGain.gain.value = 0.0;
    
    this.microphone.connect(this.scriptProcessor);
    this.scriptProcessor.connect(zeroGain);
    zeroGain.connect(this.audioContext.destination);

    // 3. Keep-alive hack
    this.keepAliveOscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();
    gainNode.gain.value = 0.001; 
    this.keepAliveOscillator.connect(gainNode);
    gainNode.connect(this.audioContext.destination);
    this.keepAliveOscillator.start();
  }

  getAnalysis(): { volume: number; tonality: number } {
    if (!this.analyser || !this.dataArray) return { volume: 0, tonality: 0 };
    this.analyser.getByteFrequencyData(this.dataArray);
    
    const fftSize = this.analyser.fftSize;
    const binCount = this.analyser.frequencyBinCount;
    const binWidth = this.sampleRate / fftSize;

    // Target Frequency Range: 900Hz - 6000Hz (Alarm/Scream range)
    const startFreq = 900;
    const endFreq = 6000;
    const startBin = Math.floor(startFreq / binWidth);
    const endBin = Math.floor(endFreq / binWidth);

    let sum = 0;
    let maxBinValue = 0;
    let activeBins = 0;

    for (let i = startBin; i < Math.min(endBin, binCount); i++) {
      const value = this.dataArray[i];
      sum += value;
      if (value > maxBinValue) maxBinValue = value;
      activeBins++;
    }

    if (activeBins === 0) return { volume: 0, tonality: 0 };

    const average = sum / activeBins;
    const volumeScore = (average / 255) * 100;

    let tonality = 0;
    if (average > 10) { 
        const peakToAvgRatio = maxBinValue / average;
        if (peakToAvgRatio > 2.5) {
            tonality = Math.min(1, (peakToAvgRatio - 2.5) / 2); 
        }
    }

    return { volume: Math.min(100, volumeScore), tonality }; 
  }

  /**
   * Retrieves the audio currently in the circular buffer as a WAV Blob.
   * capturing the LAST X seconds immediately.
   */
  async getAudioBufferBlob(): Promise<Blob | null> {
    if (!this.circularBuffer || !this.audioContext) return null;

    // Unroll the circular buffer into a linear buffer
    // The oldest data is at writeIndex (because we just overwrote the spot before it)
    const linearBuffer = new Float32Array(this.bufferLength);
    
    // Part 1: From writeIndex to End
    const part1 = this.circularBuffer.subarray(this.writeIndex);
    // Part 2: From 0 to writeIndex
    const part2 = this.circularBuffer.subarray(0, this.writeIndex);
    
    linearBuffer.set(part1);
    linearBuffer.set(part2, part1.length);

    return this.encodeWAV(linearBuffer, this.sampleRate);
  }

  private encodeWAV(samples: Float32Array, sampleRate: number): Blob {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    const writeString = (view: DataView, offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    // RIFF chunk descriptor
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(view, 8, 'WAVE');

    // fmt sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); 
    view.setUint16(22, 1, true); 
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); 
    view.setUint16(32, 2, true); 
    view.setUint16(34, 16, true); 

    // data sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);

    // Write PCM samples
    const length = samples.length;
    let index = 44;
    for (let i = 0; i < length; i++) {
        let s = Math.max(-1, Math.min(1, samples[i]));
        s = s < 0 ? s * 0x8000 : s * 0x7FFF;
        view.setInt16(index, s, true);
        index += 2;
    }

    return new Blob([view], { type: 'audio/wav' });
  }

  close() {
    try {
        if (this.keepAliveOscillator) {
            this.keepAliveOscillator.stop();
            this.keepAliveOscillator.disconnect();
        }
        
        if (this.microphone) {
            this.microphone.disconnect();
        }

        if (this.analyser) {
            this.analyser.disconnect();
        }

        if (this.scriptProcessor) {
            this.scriptProcessor.disconnect();
        }

        if (this.audioContext) {
            this.audioContext.close();
        }
    } catch (e) {
        console.warn("Error closing audio engine", e);
    }
    
    this.audioContext = null;
    this.microphone = null;
    this.analyser = null;
    this.scriptProcessor = null;
    this.circularBuffer = null;
    this.stream = null;
  }
}