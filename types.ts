export enum AppState {
  IDLE = 'IDLE',
  MONITORING = 'MONITORING',
  CYCLE_ACTIVE = 'CYCLE_ACTIVE', // Replaces RECORDING
  ANALYZING = 'ANALYZING',
  UPLOADING = 'UPLOADING',
  COOLDOWN = 'COOLDOWN'
}

export type AlertType = 'FIRE_ALARM' | 'SCREAM' | 'HEARTBEAT' | null;

export interface MonitorConfig {
  webhookUrl: string;
  locationName: string;
  sensitivity: number; // 0-100
  useGeminiAnalysis: boolean;
  heartbeatInterval: number; // Minutes, 0 = disabled
  // geminiApiKey is removed; use process.env.API_KEY
}

export interface LogEntry {
  id: string;
  timestamp: number;
  message: string;
  type: 'info' | 'alert' | 'success' | 'error';
}