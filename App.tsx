import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Settings, Activity, Radio, AlertTriangle, Eye, EyeOff, BatteryCharging, Flame, Megaphone, Mic, BrainCircuit, Camera, Ghost, MapPin, Siren, Zap, ZapOff, PlayCircle } from 'lucide-react';
import { AppState, MonitorConfig, LogEntry, AlertType } from './types';
import { AudioEngine } from './services/audioEngine';
import { SettingsModal } from './components/SettingsModal';
import { Visualizer } from './components/Visualizer';
import { analyzeEventContext } from './services/geminiService';

const CHECK_INTERVAL_MS = 100;
const CYCLE_INTERVAL_MS = 90000; 
const EMERGENCY_INTERVAL_MS = 120000; // 2 Minutes
const TOTAL_PHOTOS = 5;

// TRIGGER LOGIC CONSTANTS
const TRIGGER_TARGET = 100;
const FIRE_GAIN = 10; 
const FIRE_LOSS = 5; 
const SCREAM_GAIN = 20; 
const SCREAM_LOSS = 2; 

const STORAGE_KEY = 'sentry_guard_config';
const ACTIVE_FLAG_KEY = 'sentry_guard_active';

const TYPE_MAPPING: Record<string, string> = {
    'FIRE_ALARM': '火災警報',
    'SCREAM': '人員呼救',
    'FALSE_ALARM': '誤報',
    'UNKNOWN': '未知',
    'RATE_LIMIT': '配額耗盡',
    'HEARTBEAT': '定時監控快照',
    'EMERGENCY': '緊急狀況回報',
    'TEST': '測試訊號'
};

export default function App() {
  // State
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [config, setConfig] = useState<MonitorConfig>({
    webhookUrl: '',
    locationName: '',
    sensitivity: 70, 
    useGeminiAnalysis: false,
    heartbeatInterval: 0 // Default disabled
  });
  const [showSettings, setShowSettings] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [audioLevel, setAudioLevel] = useState(0);
  const [showCamera, setShowCamera] = useState(true);
  const [photoCount, setPhotoCount] = useState(0);
  const [stealthMode, setStealthMode] = useState(false);
  const [gpsActive, setGpsActive] = useState(false);
  const [torchActive, setTorchActive] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  
  // Detection State
  const [fireScore, setFireScore] = useState(0);
  const [screamScore, setScreamScore] = useState(0);
  const [detectedType, setDetectedType] = useState<AlertType>(null); 
  const [confirmedType, setConfirmedType] = useState<string | null>(null); 
  const [lastAnalysis, setLastAnalysis] = useState<string | null>(null); 

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const engineRef = useRef<AudioEngine>(new AudioEngine());
  const cycleTimeoutRef = useRef<number | null>(null);
  const wakeLockRef = useRef<any>(null);
  const lastHeartbeatRef = useRef<number>(Date.now());
  const isMonitoringRef = useRef(false); // Tracks active state for async ops
  const emergencyTimerRef = useRef<number | null>(null);
  
  // GPS Refs
  const gpsWatchIdRef = useRef<number | null>(null);
  const gpsLocationRef = useRef<{lat: number, lng: number} | null>(null);
  
  const fireAccRef = useRef(0);
  const screamAccRef = useRef(0);

  // Load config immediately on mount
  useEffect(() => {
    const savedConfig = localStorage.getItem(STORAGE_KEY);
    if (savedConfig) {
      try {
        const parsed = JSON.parse(savedConfig);
        if (parsed.heartbeatInterval === undefined) parsed.heartbeatInterval = 0;
        setConfig(prev => ({ ...prev, ...parsed }));
      } catch (e) {
        console.error("Failed to load config", e);
      }
    }
  }, []);

  // Save config on changes
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }, [config]);

  const addLog = useCallback((message: string, type: LogEntry['type'] = 'info') => {
    setLogs(prev => [{
      id: Math.random().toString(36).substring(7),
      timestamp: Date.now(),
      message,
      type
    }, ...prev].slice(0, 50));
  }, []);

  const toggleTorch = useCallback(async (forceState?: boolean) => {
      if (!streamRef.current) return;
      const track = streamRef.current.getVideoTracks()[0];
      if (!track) return;
      try {
          const newState = forceState !== undefined ? forceState : !torchActive;
          // @ts-ignore
          await track.applyConstraints({ advanced: [{ torch: newState }] });
          setTorchActive(newState);
      } catch (e) {
          if (forceState === true) addLog("補光燈開啟失敗", "error");
      }
  }, [torchActive, addLog]);

  const uploadWithRetry = useCallback(async (formData: FormData, retries = 3): Promise<any> => {
      for (let i = 0; i < retries; i++) {
          try {
              const response = await fetch(config.webhookUrl, { method: 'POST', body: formData });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              try { return await response.json(); } catch { return {}; }
          } catch (e) {
              const isLast = i === retries - 1;
              if (isLast) throw e;
              await new Promise(res => setTimeout(res, 1000 * Math.pow(2, i)));
          }
      }
  }, [config.webhookUrl]);

  const getRemoteControlGuide = useCallback(() => {
    return JSON.stringify({
        instruction: "【遠端控制說明】",
        command: "RELOAD_PAGE (硬重整並自動啟動), RESTART_CAMERA (軟重啟鏡頭)",
        device: config.locationName
    });
  }, [config.locationName]);

  const requestWakeLock = useCallback(async () => {
    if ('wakeLock' in navigator) {
      try {
        // @ts-ignore
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        addLog("螢幕喚醒鎖定已啟用", "success");
      } catch (err) {}
    }
  }, [addLog]);

  const initHardware = useCallback(async () => {
    try {
      addLog("正在請求感測器權限...", "info");
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: true, 
        video: { facingMode: 'environment' } 
      });
      streamRef.current = stream;
      if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
      }
      const track = stream.getVideoTracks()[0];
      if (track) {
          const capabilities = track.getCapabilities();
          // @ts-ignore
          setHasTorch(!!capabilities.torch);
      }
      await engineRef.current.init(stream);
      if ('geolocation' in navigator) {
          gpsWatchIdRef.current = navigator.geolocation.watchPosition(
              (pos) => { gpsLocationRef.current = { lat: pos.coords.latitude, lng: pos.coords.longitude }; setGpsActive(true); },
              () => setGpsActive(false),
              { enableHighAccuracy: true }
          );
      }
      await requestWakeLock();
      return true;
    } catch (error) {
      addLog("硬體初始化失敗，請檢查權限。", "error");
      return false;
    }
  }, [addLog, requestWakeLock]);

  const stopHardware = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    engineRef.current.close();
    setHasTorch(false);
    setTorchActive(false);
  }, []);

  const startMonitoring = useCallback(async (isAutoStart = false) => {
    if (isAutoStart) {
        addLog("偵測到自動啟動標記，正在恢復監控...", "alert");
    }
    const success = await initHardware();
    if (success) {
        setAppState(AppState.MONITORING);
        isMonitoringRef.current = true;
        localStorage.setItem(ACTIVE_FLAG_KEY, 'true'); // 重要：持久化狀態
        addLog("系統已啟動。全時監聽與預錄中...", "success");
        lastHeartbeatRef.current = Date.now();
    } else {
        localStorage.setItem(ACTIVE_FLAG_KEY, 'false');
    }
  }, [initHardware, addLog]);

  // AUTO-RESUME EFFECT: 處理 RELOAD_PAGE 後的自動啟動
  useEffect(() => {
      const savedState = localStorage.getItem(ACTIVE_FLAG_KEY);
      if (savedState === 'true') {
          // 給予一點延遲確保 DOM 和 Config 已就緒
          const timer = setTimeout(() => {
              startMonitoring(true);
          }, 1500);
          return () => clearTimeout(timer);
      }
  }, [startMonitoring]);

  const stopMonitoring = () => {
    isMonitoringRef.current = false;
    localStorage.setItem(ACTIVE_FLAG_KEY, 'false'); // 重要：手動停止需清除狀態
    if (cycleTimeoutRef.current) clearTimeout(cycleTimeoutRef.current);
    if (emergencyTimerRef.current) clearTimeout(emergencyTimerRef.current);
    if (torchActive) toggleTorch(false);
    stopHardware();
    if (gpsWatchIdRef.current !== null) navigator.geolocation.clearWatch(gpsWatchIdRef.current);
    setGpsActive(false);
    if (wakeLockRef.current) wakeLockRef.current.release();
    setAppState(AppState.IDLE);
    setStealthMode(false);
    addLog("系統已解除武裝 (停用)。", "info");
    setAudioLevel(0);
    setFireScore(0);
    setScreamScore(0);
  };

  const processRemoteConfig = useCallback(async (data: any) => {
    if (!data || typeof data !== 'object') return;
    if (data.locationName && data.locationName !== config.locationName) return;

    if (data.command) {
        if (data.command === 'RELOAD_PAGE') {
            addLog("收到遠端指令：頁面將於 3 秒後硬重整...", "alert");
            setTimeout(() => { window.location.reload(); }, 3000);
            return;
        }
        if (data.command === 'RESTART_CAMERA') {
            addLog("收到遠端指令：正在軟重啟鏡頭...", "alert");
            stopHardware();
            setTimeout(async () => {
                const success = await initHardware();
                if (success) addLog("鏡頭已恢復。", "success");
            }, 1000);
            return;
        }
        if ((data.command === 'TRIGGER_ALARM') && appState !== AppState.EMERGENCY) {
             setAppState(AppState.EMERGENCY);
             isMonitoringRef.current = true;
             if (hasTorch) toggleTorch(true);
        } else if (data.command === 'STOP_ALARM' && appState === AppState.EMERGENCY) {
             setAppState(AppState.MONITORING);
             if (hasTorch) toggleTorch(false);
        }
    }

    setConfig(prev => {
        let changed = false;
        const next = { ...prev };
        const updateIfValid = (key: keyof MonitorConfig, type: string) => {
            if (key in data && typeof data[key] === type && data[key] !== prev[key]) {
                // @ts-ignore
                next[key] = data[key]; changed = true;
            }
        };
        updateIfValid('sensitivity', 'number');
        updateIfValid('heartbeatInterval', 'number');
        updateIfValid('webhookUrl', 'string');
        updateIfValid('useGeminiAnalysis', 'boolean');
        if (changed) { addLog("遠端設定已更新。", "success"); return next; }
        return prev;
    });
  }, [config.locationName, appState, addLog, hasTorch, toggleTorch, initHardware, stopHardware]);

  const captureImage = useCallback(async (): Promise<Blob | null> => {
    if (streamRef.current && 'ImageCapture' in window) {
      try {
        const track = streamRef.current.getVideoTracks()[0];
        // @ts-ignore
        const capture = new ImageCapture(track);
        return await capture.takePhoto();
      } catch (e) {}
    }
    if (!videoRef.current || videoRef.current.videoWidth === 0) return null;
    const canvas = document.createElement('canvas');
    canvas.width = videoRef.current.videoWidth; canvas.height = videoRef.current.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(videoRef.current, 0, 0);
    return new Promise(res => canvas.toBlob(blob => res(blob), 'image/jpeg', 0.8));
  }, []);

  const sendHeartbeat = useCallback(async () => {
    if (!config.webhookUrl || appState !== AppState.MONITORING) return;
    try {
        const blob = await captureImage();
        if (!blob) return;
        const formData = new FormData();
        formData.append('data', blob, `hb.jpg`);
        formData.append('alert_type', 'HEARTBEAT');
        formData.append('location_name', config.locationName);
        formData.append('remote_control_guide', getRemoteControlGuide());
        const responseData = await uploadWithRetry(formData);
        if (responseData) processRemoteConfig(responseData);
        addLog("監控快照已傳送。", "success");
    } catch (e) {}
  }, [config, appState, addLog, processRemoteConfig, getRemoteControlGuide, uploadWithRetry, captureImage]);

  useEffect(() => {
    if (config.heartbeatInterval <= 0) return;
    const timer = setInterval(() => {
        const now = Date.now();
        if (now - lastHeartbeatRef.current >= config.heartbeatInterval * 60000) {
            if (appState === AppState.MONITORING && isMonitoringRef.current) {
                sendHeartbeat();
                lastHeartbeatRef.current = now; 
            }
        }
    }, 10000);
    return () => clearInterval(timer);
  }, [config.heartbeatInterval, appState, sendHeartbeat]);

  const verifyAlert = useCallback(async (type: AlertType) => {
    setAppState(AppState.ANALYZING);
    addLog(`偵測到疑似特徵，啟動 AI 判讀...`, "alert");
    try {
        const audioBlob = await engineRef.current.getAudioBufferBlob();
        const imageBlob = await captureImage();
        if (!isMonitoringRef.current || !imageBlob) {
            if (isMonitoringRef.current) setAppState(AppState.MONITORING);
            return;
        }
        if (config.useGeminiAnalysis) {
            const analysis = await analyzeEventContext(imageBlob, audioBlob, config.locationName);
            if (!isMonitoringRef.current) return;
            if (analysis.category === 'FALSE_ALARM') {
                addLog(`AI 排除警報: ${analysis.description}`, "success");
                setTimeout(() => { if (isMonitoringRef.current) setAppState(AppState.MONITORING); }, 5000);
                return;
            }
            setConfirmedType(analysis.category);
            performCycleStep(1, analysis.category, analysis.description, imageBlob, audioBlob);
        } else {
            setConfirmedType(type);
            performCycleStep(1, type || 'UNKNOWN', "本地偵測觸發", imageBlob, audioBlob);
        }
    } catch (e) { if (isMonitoringRef.current) setAppState(AppState.MONITORING); }
  }, [config, addLog, captureImage]);

  const performCycleStep = useCallback(async (step: number, type: string, desc: string, img: Blob | null = null, aud: Blob | null = null) => {
    if (!isMonitoringRef.current) return;
    setAppState(AppState.CYCLE_ACTIVE);
    setPhotoCount(step);
    const imageBlob = img || await captureImage();
    let audioBlob = aud;
    if (step > 1) {
        addLog(`週期回報 ${step}/${TOTAL_PHOTOS}...`, "info");
        await new Promise(r => setTimeout(r, 4000));
        if (isMonitoringRef.current) audioBlob = await engineRef.current.getAudioBufferBlob();
    }
    if (!isMonitoringRef.current) return;
    setAppState(AppState.UPLOADING);
    if (config.webhookUrl && imageBlob) {
        try {
            const formData = new FormData();
            formData.append('data', imageBlob, `cycle.jpg`);
            if (audioBlob) formData.append('audio', audioBlob, `cycle.wav`);
            formData.append('alert_type', TYPE_MAPPING[type] || type);
            formData.append('location_name', config.locationName);
            formData.append('description', desc);
            formData.append('cycle_step', step.toString());
            const resp = await uploadWithRetry(formData);
            if (resp) processRemoteConfig(resp);
        } catch (e) {}
    }
    if (step < TOTAL_PHOTOS && isMonitoringRef.current) {
        setAppState(AppState.COOLDOWN);
        cycleTimeoutRef.current = window.setTimeout(() => performCycleStep(step + 1, type, desc), CYCLE_INTERVAL_MS);
    } else if (isMonitoringRef.current) {
        setAppState(AppState.MONITORING);
        fireAccRef.current = 0; screamAccRef.current = 0;
    }
  }, [config, addLog, processRemoteConfig, uploadWithRetry, captureImage]);

  useEffect(() => {
    if (appState !== AppState.MONITORING) return;
    const interval = setInterval(() => {
      const { volume, tonality } = engineRef.current.getAnalysis();
      setAudioLevel(volume);
      const threshold = 100 - config.sensitivity;
      if (volume > threshold) {
        if (tonality > 0.4) fireAccRef.current = Math.min(100, fireAccRef.current + 15);
        else screamAccRef.current = Math.min(100, screamAccRef.current + 25);
      } else {
        fireAccRef.current = Math.max(0, fireAccRef.current - 5);
        screamAccRef.current = Math.max(0, screamAccRef.current - 2);
      }
      setFireScore(fireAccRef.current); setScreamScore(screamAccRef.current);
      if (fireAccRef.current >= 100) { fireAccRef.current = 0; verifyAlert('FIRE_ALARM'); }
      else if (screamAccRef.current >= 100) { screamAccRef.current = 0; verifyAlert('SCREAM'); }
    }, 100);
    return () => clearInterval(interval);
  }, [appState, config.sensitivity, verifyAlert]);

  return (
    <div className={`min-h-screen bg-background text-white flex flex-col relative ${appState === AppState.EMERGENCY ? 'border-8 border-red-600' : ''}`}>
      {stealthMode && (
          <div className="fixed inset-0 bg-black z-50 flex flex-col items-center justify-center cursor-pointer" onDoubleClick={() => setStealthMode(false)}>
             <div className="text-gray-900 text-xs font-mono">STEALTH MONITORING ACTIVE</div>
          </div>
      )}

      <header className="p-4 border-b border-gray-800 flex justify-between items-center bg-surface sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${appState === AppState.MONITORING ? 'bg-green-500 animate-pulse' : appState === AppState.EMERGENCY ? 'bg-red-600 animate-ping' : 'bg-gray-500'}`} />
          <div>
            <h1 className="font-bold text-lg">SentryGuard 哨兵</h1>
            <span className="text-[10px] text-gray-500 font-mono">v2.5 (Reliable Auto-Resume)</span>
          </div>
        </div>
        <div className="flex gap-2">
            {appState === AppState.MONITORING && (
                <button onClick={() => setStealthMode(true)} className="p-2 bg-gray-800 rounded-full text-gray-400">
                    <Ghost size={20} />
                </button>
            )}
            <button onClick={() => setShowSettings(true)} className="p-2 bg-gray-800 rounded-full">
              <Settings size={20} />
            </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col p-4 max-w-lg mx-auto w-full gap-4">
        <div className={`rounded-2xl p-6 text-center border transition-all ${
          appState === AppState.IDLE ? 'border-gray-800 bg-surface' :
          appState === AppState.EMERGENCY ? 'border-red-600 bg-red-900/60' :
          'border-green-900 bg-green-900/10'
        }`}>
          <div className="flex justify-center mb-4">
            {appState === AppState.IDLE && <Radio size={48} className="text-gray-600" />}
            {appState === AppState.EMERGENCY && <Siren size={64} className="text-red-500 animate-bounce" />}
            {appState === AppState.MONITORING && <Activity size={48} className="text-green-500 animate-pulse" />}
            {appState === AppState.ANALYZING && <BrainCircuit size={48} className="text-blue-400 animate-pulse" />}
          </div>
          <h2 className="text-2xl font-bold mb-1">
            {appState === AppState.IDLE && "待機中"}
            {appState === AppState.EMERGENCY && "緊急回報模式"}
            {appState === AppState.MONITORING && "守護中"}
            {appState === AppState.ANALYZING && "AI 分析判讀中"}
          </h2>
          <Visualizer level={audioLevel} threshold={config.sensitivity} triggered={fireScore > 0 || screamScore > 0} />
        </div>

        <div className="relative rounded-2xl overflow-hidden bg-black aspect-video border border-gray-800">
          <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
          {!showCamera && <div className="absolute inset-0 bg-black flex items-center justify-center text-gray-700 text-xs">監控持續運作中 (雙擊隱形模式關閉)</div>}
          {hasTorch && appState !== AppState.IDLE && (
             <button onClick={() => toggleTorch()} className={`absolute top-2 left-1/2 -translate-x-1/2 p-2 rounded-full ${torchActive ? 'bg-yellow-500 text-white' : 'bg-black/50 text-gray-300'}`}>
                {torchActive ? <Zap size={16} fill="currentColor" /> : <ZapOff size={16} />}
             </button>
          )}
          <button onClick={() => setShowCamera(!showCamera)} className="absolute bottom-2 right-2 bg-black/50 p-2 rounded-full">
            {showCamera ? <Eye size={16} /> : <EyeOff size={16} />}
          </button>
        </div>

        {appState === AppState.IDLE ? (
          <button onClick={() => startMonitoring(false)} className="w-full py-4 rounded-xl font-bold text-lg bg-white text-black hover:bg-gray-200 active:scale-[0.98] transition-all shadow-lg">啟動哨兵監控</button>
        ) : (
          <button onClick={stopMonitoring} className="w-full py-4 rounded-xl font-bold text-lg bg-red-900/50 text-red-200 border border-red-800 hover:bg-red-900/70 transition-all">停止監控 / 解除</button>
        )}

        <div className="flex-1 bg-surface border border-gray-800 rounded-2xl p-4 overflow-hidden flex flex-col min-h-[120px]">
          <h3 className="text-[10px] font-bold text-gray-500 uppercase mb-2">系統運作日誌</h3>
          <div className="flex-1 overflow-y-auto space-y-1 font-mono text-[10px] text-gray-500">
            {logs.map(log => (
              <div key={log.id} className={`${log.type === 'error' ? 'text-red-400' : log.type === 'alert' ? 'text-yellow-400' : log.type === 'success' ? 'text-green-400' : ''}`}>
                [{new Date(log.timestamp).toLocaleTimeString()}] {log.message}
              </div>
            ))}
          </div>
        </div>
      </main>

      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} config={config} setConfig={setConfig} onTestWebhook={() => {}} />
    </div>
  );
}