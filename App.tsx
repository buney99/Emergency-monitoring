
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Settings, Activity, Radio, AlertTriangle, Eye, EyeOff, BatteryCharging, Flame, Megaphone, Mic, BrainCircuit, Camera, Ghost, MapPin, Siren, Zap, ZapOff, PlayCircle } from 'lucide-react';
import { AppState, MonitorConfig, LogEntry, AlertType } from './types';
import { AudioEngine } from './services/audioEngine';
import { SettingsModal } from './components/SettingsModal';
import { Visualizer } from './components/Visualizer';
import { analyzeEventContext } from './services/geminiService';

const CYCLE_INTERVAL_MS = 90000; 
const TOTAL_PHOTOS = 5;
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
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [config, setConfig] = useState<MonitorConfig>({
    webhookUrl: '',
    locationName: '',
    sensitivity: 70, 
    useGeminiAnalysis: false,
    heartbeatInterval: 0 
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
  
  const [fireScore, setFireScore] = useState(0);
  const [screamScore, setScreamScore] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const engineRef = useRef<AudioEngine>(new AudioEngine());
  const cycleTimeoutRef = useRef<number | null>(null);
  const wakeLockRef = useRef<any>(null);
  const lastHeartbeatRef = useRef<number>(Date.now());
  const isMonitoringRef = useRef(false); 
  
  const gpsWatchIdRef = useRef<number | null>(null);
  const gpsLocationRef = useRef<{lat: number, lng: number} | null>(null);
  
  const fireAccRef = useRef(0);
  const screamAccRef = useRef(0);

  // 初始化配置
  useEffect(() => {
    const savedConfig = localStorage.getItem(STORAGE_KEY);
    if (savedConfig) {
      try {
        const parsed = JSON.parse(savedConfig);
        setConfig(prev => ({ ...prev, ...parsed }));
      } catch (e) {}
    }
  }, []);

  // 持久化配置
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
      } catch (e) {}
  }, [torchActive]);

  const uploadWithRetry = useCallback(async (formData: FormData, retries = 3): Promise<any> => {
      if (!config.webhookUrl) return null;
      for (let i = 0; i < retries; i++) {
          try {
              const response = await fetch(config.webhookUrl, { method: 'POST', body: formData });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              try { return await response.json(); } catch { return {}; }
          } catch (e) {
              if (i === retries - 1) throw e;
              await new Promise(res => setTimeout(res, 1000 * Math.pow(2, i)));
          }
      }
  }, [config.webhookUrl]);

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
      addLog("正在啟動感測器...", "info");
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
              (pos) => { 
                gpsLocationRef.current = { lat: pos.coords.latitude, lng: pos.coords.longitude }; 
                setGpsActive(true); 
              },
              () => setGpsActive(false),
              { enableHighAccuracy: true }
          );
      }
      await requestWakeLock();
      return true;
    } catch (error) {
      addLog("感測器啟動失敗，請確認權限。", "error");
      return false;
    }
  }, [addLog, requestWakeLock]);

  const stopHardware = useCallback(() => {
    if (streamRef.current) { 
      streamRef.current.getTracks().forEach(t => t.stop()); 
      streamRef.current = null; 
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    engineRef.current.close();
    setHasTorch(false);
    setTorchActive(false);
  }, []);

  const startMonitoring = useCallback(async (isAutoStart = false) => {
    if (isAutoStart) addLog("恢復自動監控中...", "alert");
    const success = await initHardware();
    if (success) {
        setAppState(AppState.MONITORING);
        isMonitoringRef.current = true;
        localStorage.setItem(ACTIVE_FLAG_KEY, 'true');
        addLog("系統守護中。", "success");
        lastHeartbeatRef.current = Date.now();
    } else {
        localStorage.setItem(ACTIVE_FLAG_KEY, 'false');
    }
  }, [initHardware, addLog]);

  useEffect(() => {
      if (localStorage.getItem(ACTIVE_FLAG_KEY) === 'true') {
          const timer = setTimeout(() => startMonitoring(true), 1500);
          return () => clearTimeout(timer);
      }
  }, [startMonitoring]);

  const stopMonitoring = useCallback(() => {
    isMonitoringRef.current = false;
    localStorage.setItem(ACTIVE_FLAG_KEY, 'false');
    if (cycleTimeoutRef.current) clearTimeout(cycleTimeoutRef.current);
    if (torchActive) toggleTorch(false);
    stopHardware();
    if (gpsWatchIdRef.current !== null) navigator.geolocation.clearWatch(gpsWatchIdRef.current);
    setGpsActive(false);
    if (wakeLockRef.current) wakeLockRef.current.release();
    setAppState(AppState.IDLE);
    setStealthMode(false);
    addLog("監控已停用。", "info");
    setAudioLevel(0); setFireScore(0); setScreamScore(0);
  }, [addLog, stopHardware, torchActive, toggleTorch]);

  const processRemoteConfig = useCallback(async (data: any) => {
    if (!data || typeof data !== 'object') return;
    
    if (data.locationName && config.locationName && data.locationName !== config.locationName) {
        return; // 忽略非目標指令
    }

    // 更新設定
    setConfig(prev => {
        const next = { ...prev };
        let changed = false;
        const keys: (keyof MonitorConfig)[] = ['sensitivity', 'heartbeatInterval', 'webhookUrl', 'useGeminiAnalysis'];
        keys.forEach(k => {
            if (k in data && data[k] !== prev[k]) {
                // @ts-ignore
                next[k] = data[k]; changed = true;
            }
        });
        if (changed) {
            addLog("遠端設定已同步。", "success");
            return next;
        }
        return prev;
    });

    // 執行指令
    if (data.command) {
        if (data.command === 'RELOAD_PAGE') {
            addLog("執行遠端更新指令...", "alert");
            setTimeout(() => { 
                const url = new URL(window.location.href);
                url.searchParams.set('v', Date.now().toString());
                window.location.href = url.toString();
            }, 1000);
        } else if (data.command === 'RESTART_CAMERA') {
            stopHardware();
            setTimeout(async () => { await initHardware(); addLog("鏡頭已重啟。", "success"); }, 1000);
        } else if (data.command === 'TRIGGER_ALARM' && appState !== AppState.EMERGENCY) {
             setAppState(AppState.EMERGENCY);
             if (hasTorch) toggleTorch(true);
        } else if (data.command === 'STOP_ALARM' && appState === AppState.EMERGENCY) {
             setAppState(AppState.MONITORING);
             if (hasTorch) toggleTorch(false);
        }
    }
  }, [config.locationName, appState, addLog, hasTorch, toggleTorch, initHardware, stopHardware]);

  const captureImage = useCallback(async (): Promise<Blob | null> => {
    if (!videoRef.current || videoRef.current.videoWidth === 0) return null;
    const canvas = document.createElement('canvas');
    canvas.width = videoRef.current.videoWidth; 
    canvas.height = videoRef.current.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(videoRef.current, 0, 0);
    return new Promise(res => canvas.toBlob(blob => res(blob), 'image/jpeg', 0.85));
  }, []);

  const sendHeartbeat = useCallback(async () => {
    if (!config.webhookUrl || !isMonitoringRef.current) return;
    try {
        const blob = await captureImage();
        if (!blob) return;
        const formData = new FormData();
        formData.append('data', blob, `hb.jpg`);
        formData.append('alert_type', 'HEARTBEAT');
        formData.append('location_name', config.locationName);
        if (gpsLocationRef.current) {
            formData.append('lat', gpsLocationRef.current.lat.toString());
            formData.append('lng', gpsLocationRef.current.lng.toString());
        }
        const resp = await uploadWithRetry(formData);
        if (resp) processRemoteConfig(resp);
        addLog("監控快照傳送成功。", "success");
    } catch (e) {}
  }, [config, captureImage, uploadWithRetry, processRemoteConfig, addLog]);

  useEffect(() => {
    if (config.heartbeatInterval <= 0) return;
    const timer = setInterval(() => {
        const now = Date.now();
        if (now - lastHeartbeatRef.current >= config.heartbeatInterval * 60000) {
            if (isMonitoringRef.current && appState === AppState.MONITORING) {
                sendHeartbeat();
                lastHeartbeatRef.current = now;
            }
        }
    }, 15000);
    return () => clearInterval(timer);
  }, [config.heartbeatInterval, appState, sendHeartbeat]);

  const performCycleStep = useCallback(async (step: number, type: string, desc: string, img: Blob | null = null, aud: Blob | null = null) => {
    if (!isMonitoringRef.current) return;
    
    setAppState(AppState.CYCLE_ACTIVE);
    setPhotoCount(step);
    
    const imageBlob = img || await captureImage();
    let audioBlob = aud;
    
    if (step > 1) {
        addLog(`循環通報 ${step}/${TOTAL_PHOTOS}...`, "info");
        await new Promise(r => setTimeout(r, 4000));
        if (isMonitoringRef.current) audioBlob = await engineRef.current.getAudioBufferBlob();
    }
    
    if (!isMonitoringRef.current) return;
    
    setAppState(AppState.UPLOADING);
    const formData = new FormData();
    if (imageBlob) formData.append('data', imageBlob, `alert_${step}.jpg`);
    if (audioBlob) formData.append('audio', audioBlob, `alert_${step}.wav`);
    formData.append('alert_type', TYPE_MAPPING[type] || type);
    formData.append('location_name', config.locationName);
    formData.append('description', desc);
    formData.append('cycle_step', step.toString());
    
    try {
        const resp = await uploadWithRetry(formData);
        if (resp) processRemoteConfig(resp);
    } catch (e) {
        addLog("通報上傳失敗，將重試。", "error");
    }

    if (step < TOTAL_PHOTOS && isMonitoringRef.current) {
        setAppState(AppState.COOLDOWN);
        cycleTimeoutRef.current = window.setTimeout(() => performCycleStep(step + 1, type, desc), CYCLE_INTERVAL_MS);
    } else if (isMonitoringRef.current) {
        setAppState(AppState.MONITORING);
        fireAccRef.current = 0; screamAccRef.current = 0;
    }
  }, [config, addLog, processRemoteConfig, uploadWithRetry, captureImage]);

  const verifyAlert = useCallback(async (type: AlertType) => {
    setAppState(AppState.ANALYZING);
    addLog(`偵測異常特徵，啟動 AI 驗證...`, "alert");
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
                setTimeout(() => { if (isMonitoringRef.current) setAppState(AppState.MONITORING); }, 4000);
                return;
            }
            performCycleStep(1, analysis.category, analysis.description, imageBlob, audioBlob);
        } else {
            performCycleStep(1, type || 'UNKNOWN', "硬體偵測觸發", imageBlob, audioBlob);
        }
    } catch (e) { 
        if (isMonitoringRef.current) setAppState(AppState.MONITORING); 
    }
  }, [config, addLog, captureImage, performCycleStep]);

  useEffect(() => {
    if (appState !== AppState.MONITORING) return;
    const interval = setInterval(() => {
      const { volume, tonality } = engineRef.current.getAnalysis();
      setAudioLevel(volume);
      
      const threshold = 100 - config.sensitivity;
      if (volume > threshold) {
        if (tonality > 0.4) fireAccRef.current = Math.min(100, fireAccRef.current + 18);
        else screamAccRef.current = Math.min(100, screamAccRef.current + 25);
      } else {
        fireAccRef.current = Math.max(0, fireAccRef.current - 4);
        screamAccRef.current = Math.max(0, screamAccRef.current - 2);
      }
      
      setFireScore(fireAccRef.current); 
      setScreamScore(screamAccRef.current);
      
      if (fireAccRef.current >= 100) { fireAccRef.current = 0; verifyAlert('FIRE_ALARM'); }
      else if (screamAccRef.current >= 100) { screamAccRef.current = 0; verifyAlert('SCREAM'); }
    }, 100);
    return () => clearInterval(interval);
  }, [appState, config.sensitivity, verifyAlert]);

  // 組件卸載清理
  useEffect(() => {
    return () => {
      isMonitoringRef.current = false;
      stopHardware();
    };
  }, [stopHardware]);

  return (
    <div className={`min-h-screen bg-background text-white flex flex-col relative transition-colors duration-500 ${appState === AppState.EMERGENCY ? 'border-8 border-red-600' : ''}`}>
      {stealthMode && (
          <div className="fixed inset-0 bg-black z-50 flex flex-col items-center justify-center cursor-pointer" onDoubleClick={() => setStealthMode(false)}>
             <div className="text-gray-900 text-[12px] font-mono tracking-widest opacity-20">SYSTEM GUARD ACTIVE</div>
          </div>
      )}

      <header className="p-4 border-b border-gray-800 flex justify-between items-center bg-surface sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${appState === AppState.MONITORING ? 'bg-green-500 animate-pulse' : appState === AppState.EMERGENCY ? 'bg-red-600 animate-ping' : 'bg-gray-500'}`} />
          <div>
            <h1 className="font-bold text-lg tracking-tight">SentryGuard 哨兵</h1>
            <span className="text-[10px] text-gray-500 font-mono">v2.8 (Optimized)</span>
          </div>
        </div>
        <div className="flex gap-2">
            {appState === AppState.MONITORING && (
                <button onClick={() => setStealthMode(true)} className="p-2.5 bg-gray-800 rounded-xl text-gray-400 active:scale-90 transition-transform">
                    <Ghost size={20} />
                </button>
            )}
            <button onClick={() => setShowSettings(true)} className="p-2.5 bg-gray-800 rounded-xl active:scale-90 transition-transform">
              <Settings size={20} />
            </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col p-4 max-w-lg mx-auto w-full gap-4">
        <div className={`rounded-3xl p-6 text-center border transition-all duration-500 ${
          appState === AppState.IDLE ? 'border-gray-800 bg-surface' :
          appState === AppState.EMERGENCY ? 'border-red-600 bg-red-900/40' :
          'border-green-900/30 bg-green-950/10'
        }`}>
          <div className="flex justify-center mb-4">
            {appState === AppState.IDLE && <Radio size={48} className="text-gray-600" />}
            {appState === AppState.EMERGENCY && <Siren size={64} className="text-red-500 animate-bounce" />}
            {appState === AppState.MONITORING && <Activity size={48} className="text-green-500 animate-pulse" />}
            {(appState === AppState.ANALYZING || appState === AppState.UPLOADING) && <BrainCircuit size={48} className="text-blue-400 animate-pulse" />}
          </div>
          <h2 className="text-2xl font-black mb-1">
            {appState === AppState.IDLE && "待機中"}
            {appState === AppState.EMERGENCY && "緊急報警"}
            {appState === AppState.MONITORING && "守護中"}
            {appState === AppState.ANALYZING && "AI 判讀"}
            {appState === AppState.UPLOADING && "上傳中"}
            {appState === AppState.COOLDOWN && "冷卻等待"}
          </h2>
          <Visualizer level={audioLevel} threshold={config.sensitivity} triggered={fireScore > 0 || screamScore > 0} />
        </div>

        <div className="relative rounded-3xl overflow-hidden bg-black aspect-video border border-gray-800 shadow-2xl">
          <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
          {!showCamera && <div className="absolute inset-0 bg-black flex items-center justify-center text-gray-700 text-xs font-mono">CAMERA MASKED</div>}
          {hasTorch && appState !== AppState.IDLE && (
             <button onClick={() => toggleTorch()} className={`absolute top-4 left-1/2 -translate-x-1/2 p-3 rounded-full backdrop-blur-md shadow-lg transition-colors ${torchActive ? 'bg-yellow-500 text-white' : 'bg-black/40 text-gray-300'}`}>
                {torchActive ? <Zap size={20} fill="currentColor" /> : <ZapOff size={20} />}
             </button>
          )}
          <button onClick={() => setShowCamera(!showCamera)} className="absolute bottom-4 right-4 bg-black/60 p-3 rounded-2xl backdrop-blur-md text-gray-300">
            {showCamera ? <Eye size={20} /> : <EyeOff size={20} />}
          </button>
          {gpsActive && <div className="absolute bottom-4 left-4 p-1 bg-black/40 rounded-lg"><MapPin size={14} className="text-blue-400" /></div>}
        </div>

        {appState === AppState.IDLE ? (
          <button onClick={() => startMonitoring(false)} className="w-full py-5 rounded-2xl font-black text-xl bg-white text-black hover:bg-gray-200 active:scale-[0.96] transition-all shadow-xl">啟動監控</button>
        ) : (
          <button onClick={stopMonitoring} className="w-full py-5 rounded-2xl font-black text-xl bg-red-950 text-red-200 border border-red-900 active:scale-[0.96] transition-all">停止監控</button>
        )}

        <div className="flex-1 bg-surface border border-gray-800 rounded-3xl p-5 overflow-hidden flex flex-col min-h-[160px]">
          <h3 className="text-[11px] font-bold text-gray-600 uppercase mb-3 flex justify-between">
            <span>系統日誌</span>
            <span>{config.locationName}</span>
          </h3>
          <div className="flex-1 overflow-y-auto space-y-1.5 font-mono text-[11px] text-gray-500">
            {logs.length === 0 && <div className="italic text-gray-700">等待事件中...</div>}
            {logs.map(log => (
              <div key={log.id} className={`leading-relaxed ${log.type === 'error' ? 'text-red-400' : log.type === 'alert' ? 'text-yellow-400' : log.type === 'success' ? 'text-green-400' : ''}`}>
                <span className="opacity-50">[{new Date(log.timestamp).toLocaleTimeString([], {hour12:false})}]</span> {log.message}
              </div>
            ))}
          </div>
        </div>
      </main>

      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} config={config} setConfig={setConfig} onTestWebhook={() => {}} />
    </div>
  );
}
