export class AudioEngine {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private microphone: MediaStreamAudioSourceNode | null = null;
  private dataArray: Uint8Array | null = null;
  private stream: MediaStream | null = null;
  private keepAliveOscillator: OscillatorNode | null = null;
  
  // WAV Recording
  private recorderNode: ScriptProcessorNode | null = null;
  private recordedBuffers: Float32Array[] = [];
  private recordingLength: number = 0;
  private isRecording: boolean = false;
  private sampleRate: number = 44100;

  async init(stream: MediaStream) {
    // Close existing if open to prevent duplicates
    if (this.audioContext) {
        this.close();
    }

    this.stream = stream;
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    
    // Ensure context is running (fixes issues on some mobile browsers)
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    this.sampleRate = this.audioContext.sampleRate;
    
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512; 
    this.analyser.smoothingTimeConstant = 0.2;

    this.microphone = this.audioContext.createMediaStreamSource(stream);
    this.microphone.connect(this.analyser);
    
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

    // Keep-alive hack: plays silent audio to prevent iOS/Android from sleeping the audio context
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

  // --- WAV Recording Functions ---

  startRecording() {
    if (!this.audioContext || !this.microphone) return;
    if (this.isRecording) return; // Already recording

    this.recordedBuffers = [];
    this.recordingLength = 0;
    this.isRecording = true;

    // Use ScriptProcessor
    this.recorderNode = this.audioContext.createScriptProcessor(4096, 1, 1);
    
    this.recorderNode.onaudioprocess = (e) => {
      if (!this.isRecording) return;
      const input = e.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input);
      this.recordedBuffers.push(copy);
      this.recordingLength += copy.length;
    };

    // Mute destination
    const zeroGain = this.audioContext.createGain();
    zeroGain.gain.value = 0.0;
    
    this.microphone.connect(this.recorderNode);
    this.recorderNode.connect(zeroGain);
    zeroGain.connect(this.audioContext.destination);
  }

  async stopRecording(): Promise<Blob | null> {
    this.isRecording = false;
    
    if (this.recorderNode) {
        this.recorderNode.disconnect();
        this.recorderNode = null;
    }

    if (this.recordingLength === 0) {
        this.recordedBuffers = [];
        return null;
    }

    // 1. Flatten buffer
    const mergedBuffers = this.mergeBuffers(this.recordedBuffers, this.recordingLength);
    
    // 2. Encode to WAV
    const wavBlob = this.encodeWAV(mergedBuffers, this.sampleRate);
    
    // Cleanup memory immediately
    this.recordedBuffers = [];
    this.recordingLength = 0;

    return wavBlob;
  }

  private mergeBuffers(buffers: Float32Array[], length: number): Float32Array {
    const result = new Float32Array(length);
    let offset = 0;
    for (const buffer of buffers) {
      result.set(buffer, offset);
      offset += buffer.length;
    }
    return result;
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
    this.isRecording = false;
    
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

        if (this.recorderNode) {
            this.recorderNode.disconnect();
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
    this.recorderNode = null;
    this.stream = null;
  }
}