import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Settings, Activity, Radio, AlertTriangle, Eye, EyeOff, BatteryCharging, Flame, Megaphone, Mic, BrainCircuit, Camera, Ghost } from 'lucide-react';
import { AppState, MonitorConfig, LogEntry, AlertType } from './types';
import { AudioEngine } from './services/audioEngine';
import { SettingsModal } from './components/SettingsModal';
import { Visualizer } from './components/Visualizer';
import { analyzeEventContext } from './services/geminiService';

const CHECK_INTERVAL_MS = 100;
const CYCLE_INTERVAL_MS = 90000; 
const TOTAL_PHOTOS = 3;
const RECORDING_DURATION_MS = 4000; 

// TRIGGER LOGIC CONSTANTS
const TRIGGER_TARGET = 100;
const FIRE_GAIN = 10; 
const FIRE_LOSS = 5; 
const SCREAM_GAIN = 20; 
const SCREAM_LOSS = 2; 

const STORAGE_KEY = 'sentry_guard_config';

const TYPE_MAPPING: Record<string, string> = {
    'FIRE_ALARM': '火災警報',
    'SCREAM': '人員呼救',
    'FALSE_ALARM': '誤報',
    'UNKNOWN': '未知',
    'RATE_LIMIT': '配額耗盡',
    'HEARTBEAT': '定時監控快照'
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
  
  const fireAccRef = useRef(0);
  const screamAccRef = useRef(0);

  // Load config
  useEffect(() => {
    const savedConfig = localStorage.getItem(STORAGE_KEY);
    if (savedConfig) {
      try {
        const parsed = JSON.parse(savedConfig);
        const { geminiApiKey, ...validConfig } = parsed;
        if (validConfig.heartbeatInterval === undefined) validConfig.heartbeatInterval = 0;
        setConfig(prev => ({ ...prev, ...validConfig }));
      } catch (e) {
        console.error("Failed to load config", e);
      }
    }
  }, []);

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

  // --- Remote Configuration Logic ---
  const processRemoteConfig = useCallback((data: any) => {
    if (!data || typeof data !== 'object') return;
    
    // STRICT IDENTITY CHECK
    // The server MUST echo the correct locationName to confirm it's configuring the right device.
    const currentLocName = config.locationName;
    const receivedLocName = data.locationName;

    if (receivedLocName !== currentLocName) {
         if (receivedLocName !== undefined) {
             addLog(`遠端設定拒絕：身分驗證失敗 (收到: '${receivedLocName}' vs 本機: '${currentLocName}')`, "error");
         }
         // If missing or mismatch, reject entire config
         return; 
    }

    setConfig(prev => {
        let changed = false;
        const next = { ...prev };
        
        // Helper to safely update if value exists and is correct type
        const updateIfValid = (key: keyof MonitorConfig, type: string) => {
            if (key in data && typeof data[key] === type) {
                // @ts-ignore
                if (data[key] !== prev[key]) {
                    // @ts-ignore
                    next[key] = data[key];
                    changed = true;
                }
            }
        };

        // EXPLICITLY ALLOWED REMOTE SETTINGS
        updateIfValid('sensitivity', 'number');
        updateIfValid('heartbeatInterval', 'number');
        updateIfValid('webhookUrl', 'string');
        updateIfValid('useGeminiAnalysis', 'boolean');
        
        // locationName is intentionally NOT updated here, even if it matches.
        // It acts solely as a verification key.

        if (changed) {
            addLog("收到遠端指令：身分驗證成功，設定已更新。", "success");
            return next;
        }
        return prev;
    });
  }, [config.locationName, addLog]);

  // Generate the guide JSON string
  const getRemoteControlGuide = useCallback(() => {
    const guide = {
        instruction: `【遠端控制說明】
1. 本裝置身分 ID 為 '${config.locationName}'。
2. 安全驗證機制：伺服器回傳的 JSON 設定檔中，必須包含 "locationName": "${config.locationName}" 且完全一致。
3. 若 locationName 不符或缺失，裝置將拒絕更新任何設定，以防止錯誤覆蓋。
4. 僅支援修改：sensitivity, heartbeatInterval, useGeminiAnalysis, webhookUrl。`,
        template_to_copy: {
            locationName: config.locationName, // Required for verification
            sensitivity: config.sensitivity,
            heartbeatInterval: config.heartbeatInterval,
            useGeminiAnalysis: config.useGeminiAnalysis,
            webhookUrl: config.webhookUrl
        },
        field_definitions: {
            locationName: "字串：必須與本機 ID 完全一致 (驗證用，不可修改)",
            sensitivity: "整數 (10-90)：數值越高越敏感",
            heartbeatInterval: "整數 (0-60)：定時快照間隔(分)，0 為關閉",
            useGeminiAnalysis: "布林值 (true/false)：啟用 AI",
            webhookUrl: "字串：Server URL"
        }
    };
    return JSON.stringify(guide, null, 2);
  }, [config]);

  const requestWakeLock = useCallback(async () => {
    if ('wakeLock' in navigator) {
      try {
        // @ts-ignore
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        addLog("螢幕喚醒鎖定已啟用", "success");
      } catch (err) {
        console.warn("Wake Lock failed:", err);
      }
    }
  }, [addLog]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && appState === AppState.MONITORING) {
        requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [appState, requestWakeLock]);

  const captureImage = async (): Promise<Blob | null> => {
    if (!videoRef.current) return null;
    const canvas = document.createElement('canvas');
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(videoRef.current, 0, 0);
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.8));
  };

  const sendHeartbeat = useCallback(async () => {
    if (!config.webhookUrl) return;
    
    if (appState !== AppState.MONITORING) return;

    try {
        addLog(`正在發送定時監控快照 (每 ${config.heartbeatInterval} 分鐘)...`, "info");
        const blob = await captureImage();
        if (!blob) return;

        const formData = new FormData();
        formData.append('image', blob, `heartbeat-${Date.now()}.jpg`);
        formData.append('alert_type', '定時監控快照');
        formData.append('location_name', config.locationName || '未知地點');
        formData.append('description', '系統正常運作中 (定時自動回報)');
        formData.append('cycle_step', '0');
        
        // Add Guide
        formData.append('remote_control_guide', getRemoteControlGuide());

        const response = await fetch(config.webhookUrl, { method: 'POST', body: formData });
        
        // Check for remote config updates
        if (response.ok) {
            try {
                const responseData = await response.json();
                processRemoteConfig(responseData);
            } catch (e) {
                // Ignore JSON parse errors (server might return text)
            }
        }

        addLog("監控快照已傳送。", "success");
    } catch (e) {
        addLog("監控快照傳送失敗 (Webhook Error)。", "error");
    }
  }, [config, appState, addLog, processRemoteConfig, getRemoteControlGuide]);

  // Log enablement when config changes
  useEffect(() => {
    if (config.heartbeatInterval > 0) {
        // Don't log on every render, strictly dependent on config change
        // We reset lastHeartbeatRef to now so we don't trigger immediately if the interval was just increased
        lastHeartbeatRef.current = Date.now();
    }
  }, [config.heartbeatInterval]);

  // Heartbeat Check Loop
  useEffect(() => {
    if (config.heartbeatInterval <= 0) return;

    const checkHeartbeat = () => {
        const now = Date.now();
        const intervalMs = config.heartbeatInterval * 60 * 1000;
        
        if (now - lastHeartbeatRef.current >= intervalMs) {
            if (appState === AppState.MONITORING && isMonitoringRef.current) {
                sendHeartbeat();
                lastHeartbeatRef.current = now; 
            }
        }
    };

    const timer = setInterval(checkHeartbeat, 5000); 
    return () => clearInterval(timer);
  }, [config.heartbeatInterval, appState, sendHeartbeat]);

  const startMonitoring = async () => {
    if (config.useGeminiAnalysis && !process.env.API_KEY) {
      addLog("警告: 已啟用 AI 分析，但未檢測到環境變數 API Key", "alert");
    }

    try {
      addLog("正在請求麥克風與相機權限...", "info");
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: true, 
        video: { facingMode: 'environment' } 
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;

      await engineRef.current.init(stream);
      
      setAppState(AppState.MONITORING);
      isMonitoringRef.current = true;
      
      addLog("系統已啟動。監控中...", "success");
      setLastAnalysis(null);
      lastHeartbeatRef.current = Date.now();
      await requestWakeLock();
    } catch (error) {
      addLog("無法存取感測器，請確認瀏覽器權限設定。", "error");
      console.error(error);
    }
  };

  const stopMonitoring = () => {
    isMonitoringRef.current = false;

    if (cycleTimeoutRef.current) clearTimeout(cycleTimeoutRef.current);
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    engineRef.current.close();
    
    if (wakeLockRef.current) {
      wakeLockRef.current.release();
      wakeLockRef.current = null;
    }

    setAppState(AppState.IDLE);
    setStealthMode(false);
    addLog("系統已解除武裝 (停用)。", "info");
    setAudioLevel(0);
    setPhotoCount(0);
    setFireScore(0);
    setScreamScore(0);
    setDetectedType(null);
    setConfirmedType(null);
    setLastAnalysis(null);
    fireAccRef.current = 0;
    screamAccRef.current = 0;
  };

  const verifyAlert = useCallback(async (preliminaryType: AlertType) => {
    setAppState(AppState.ANALYZING);
    const chineseType = TYPE_MAPPING[preliminaryType || 'UNKNOWN'];
    addLog(`偵測到疑似 ${chineseType}。正在進行 AI 驗證...`, "alert");

    try {
        engineRef.current.startRecording();
        
        // Wait for recording
        await new Promise(resolve => setTimeout(resolve, RECORDING_DURATION_MS));
        
        // Safety check
        if (!isMonitoringRef.current) return;

        const audioBlob = await engineRef.current.stopRecording();
        const imageBlob = await captureImage();

        if (!imageBlob) {
            addLog("相機擷取失敗，重置系統。", "error");
            if (isMonitoringRef.current) setAppState(AppState.MONITORING);
            return;
        }

        if (config.useGeminiAnalysis) {
            addLog("傳送資料至 Gemini 進行分析...", "info");
            const analysis = await analyzeEventContext(imageBlob, audioBlob, config.locationName);
            
            if (!isMonitoringRef.current) return;

            // Handle Rate Limits
            if (analysis.category === 'RATE_LIMIT') {
                addLog(`API 錯誤: ${analysis.description}`, "error");
                let timeLeft = 60;
                setLastAnalysis(`配額耗盡，系統強制冷卻 ${timeLeft} 秒...`);
                setAppState(AppState.COOLDOWN);
                
                const timer = setInterval(() => {
                    if (!isMonitoringRef.current) {
                        clearInterval(timer);
                        return;
                    }
                    timeLeft -= 1;
                    setLastAnalysis(`配額耗盡，系統強制冷卻 ${timeLeft} 秒...`);
                    if (timeLeft <= 0) {
                        clearInterval(timer);
                        setAppState(AppState.MONITORING);
                        setLastAnalysis(null);
                        fireAccRef.current = 0;
                        screamAccRef.current = 0;
                        setFireScore(0);
                        setScreamScore(0);
                    }
                }, 1000);
                return;
            }

            if (analysis.category === 'FALSE_ALARM') {
                const reason = analysis.description || "未提供原因";
                addLog(`AI 排除警報: ${reason}`, "success"); 
                setLastAnalysis(`上次分析結果: 誤報 - ${reason}`);
                
                setTimeout(() => {
                    if (isMonitoringRef.current) {
                        setAppState(AppState.MONITORING);
                        fireAccRef.current = 0;
                        screamAccRef.current = 0;
                        setFireScore(0);
                        setScreamScore(0);
                    }
                }, 10000);
                return;
            }

            // Confirmed
            const confirmedChinese = TYPE_MAPPING[analysis.category] || analysis.category;
            setConfirmedType(analysis.category);
            addLog(`AI 確認: ${confirmedChinese} (${analysis.confidence}%). 描述: ${analysis.description}`, "alert");
            setLastAnalysis(null);
            performCycleStep(1, analysis.category, analysis.description, imageBlob, audioBlob);

        } else {
            addLog("AI 功能未啟用，採用本地偵測結果。", "alert");
            setConfirmedType(preliminaryType);
            performCycleStep(1, preliminaryType || 'UNKNOWN', "本地偵測 (無 AI 分析)", imageBlob, audioBlob);
        }
    } catch (e) {
        console.error("Verification failed", e);
        if (isMonitoringRef.current) setAppState(AppState.MONITORING);
    }
  }, [config, addLog]);


  const performCycleStep = useCallback(async (
    currentStep: number, 
    finalType: string, 
    description: string,
    existingBlob: Blob | null = null,
    providedAudioBlob: Blob | null = null
  ) => {
    if (!isMonitoringRef.current) return;

    setAppState(AppState.CYCLE_ACTIVE);
    setPhotoCount(currentStep);
    
    // 1. Image Logic
    let imageBlob = existingBlob;
    if (!imageBlob || currentStep > 1) {
        imageBlob = await captureImage();
    }

    if (!imageBlob) {
      addLog("影像擷取失敗。", "error");
    }

    // 2. Audio Logic
    let audioBlob = providedAudioBlob;
    if (currentStep > 1) {
        addLog(`週期回報 (${currentStep}/${TOTAL_PHOTOS}): 正在錄製最新現場音...`, "info");
        try {
            engineRef.current.startRecording();
            await new Promise(resolve => setTimeout(resolve, RECORDING_DURATION_MS));
            if (!isMonitoringRef.current) return;
            audioBlob = await engineRef.current.stopRecording();
        } catch (e) {
            console.warn("Follow-up recording failed", e);
        }
    }

    // Upload
    if (!isMonitoringRef.current) return;
    setAppState(AppState.UPLOADING);
    
    if (config.webhookUrl && imageBlob) {
        try {
            const chineseType = TYPE_MAPPING[finalType] || finalType;
            const location = config.locationName || '未知地點';

            const formData = new FormData();
            formData.append('image', imageBlob, `alert-${finalType}-${Date.now()}.jpg`);
            
            if (audioBlob) {
              const ext = 'wav';
              formData.append('audio', audioBlob, `audio-${finalType}-${Date.now()}.${ext}`);
            }

            formData.append('alert_type', chineseType); 
            formData.append('location_name', location);
            formData.append('description', description);
            formData.append('cycle_step', currentStep.toString());
            
            // Add Guide
            formData.append('remote_control_guide', getRemoteControlGuide());

            const response = await fetch(config.webhookUrl, { method: 'POST', body: formData });
            
            // Check for remote config updates
            if (response.ok) {
                try {
                    const responseData = await response.json();
                    processRemoteConfig(responseData);
                } catch (e) {
                     // Ignore JSON parse errors
                }
            }
            
            addLog("上傳成功。", "success");
        } catch (e) {
            addLog("上傳失敗。", "error");
        }
    }

    if (!isMonitoringRef.current) return;

    if (currentStep < TOTAL_PHOTOS) {
      setAppState(AppState.COOLDOWN);
      cycleTimeoutRef.current = window.setTimeout(() => {
        performCycleStep(currentStep + 1, finalType, description, null, null);
      }, CYCLE_INTERVAL_MS);
    } else {
      addLog("警報流程結束，系統重新武裝。", "success");
      setAppState(AppState.MONITORING);
      setDetectedType(null);
      setConfirmedType(null);
      fireAccRef.current = 0;
      screamAccRef.current = 0;
      setFireScore(0);
      setScreamScore(0);
    }
  }, [config, addLog, processRemoteConfig, getRemoteControlGuide]);

  // Monitoring Loop
  useEffect(() => {
    if (appState !== AppState.MONITORING) return;

    const interval = setInterval(() => {
      const { volume, tonality } = engineRef.current.getAnalysis();
      setAudioLevel(volume);

      const threshold = 100 - config.sensitivity;

      if (volume > threshold) {
        if (tonality > 0.4) {
          fireAccRef.current = Math.min(TRIGGER_TARGET, fireAccRef.current + FIRE_GAIN);
          screamAccRef.current = Math.max(0, screamAccRef.current - 1);
        } else {
          screamAccRef.current = Math.min(TRIGGER_TARGET, screamAccRef.current + SCREAM_GAIN);
          fireAccRef.current = Math.max(0, fireAccRef.current - 1);
        }
      } else {
        fireAccRef.current = Math.max(0, fireAccRef.current - FIRE_LOSS);
        screamAccRef.current = Math.max(0, screamAccRef.current - SCREAM_LOSS);
      }

      setFireScore(fireAccRef.current);
      setScreamScore(screamAccRef.current);

      if (fireAccRef.current >= TRIGGER_TARGET) {
        fireAccRef.current = 0;
        setDetectedType('FIRE_ALARM');
        verifyAlert('FIRE_ALARM'); 
      } else if (screamAccRef.current >= TRIGGER_TARGET) {
        screamAccRef.current = 0;
        setDetectedType('SCREAM');
        verifyAlert('SCREAM'); 
      }

    }, CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [appState, config.sensitivity, verifyAlert]);

  // UI Helpers
  const maxScore = Math.max(fireScore, screamScore);

  return (
    <div className="min-h-screen bg-background text-white flex flex-col font-sans relative">
      {/* Stealth Mode Overlay */}
      {stealthMode && (
          <div 
            className="fixed inset-0 bg-black z-50 flex flex-col items-center justify-center cursor-pointer select-none"
            onDoubleClick={() => setStealthMode(false)}
          >
             <div className="text-gray-900 text-sm">系統運作中... (雙擊螢幕喚醒)</div>
          </div>
      )}

      {/* Header */}
      <header className="p-4 border-b border-gray-800 flex justify-between items-center bg-surface sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${appState === AppState.MONITORING ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`} />
          <h1 className="font-bold text-lg tracking-tight">SentryGuard 哨兵監控</h1>
        </div>
        <div className="flex gap-2">
            {appState === AppState.MONITORING && (
                <button 
                  onClick={() => setStealthMode(true)} 
                  className="p-2 bg-gray-800 rounded-full hover:bg-gray-700 transition text-gray-400 hover:text-white"
                  title="隱形模式 (黑屏)"
                >
                    <Ghost size={20} />
                </button>
            )}
            <button onClick={() => setShowSettings(true)} className="p-2 bg-gray-800 rounded-full hover:bg-gray-700 transition">
              <Settings size={20} />
            </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col p-4 max-w-lg mx-auto w-full gap-4">
        
        {/* Status Card */}
        <div className={`rounded-2xl p-6 text-center border transition-colors duration-500 ${
          appState === AppState.IDLE ? 'border-gray-700 bg-surface' :
          appState === AppState.ANALYZING ? 'border-blue-500 bg-blue-900/30' : 
          confirmedType === 'FIRE_ALARM' ? 'border-red-600 bg-red-900/40' :
          confirmedType === 'SCREAM' ? 'border-orange-600 bg-orange-900/40' :
          maxScore > 50 ? 'border-yellow-500 bg-yellow-900/10' :
          'border-green-900 bg-green-900/10'
        }`}>
          <div className="flex justify-center mb-4">
            {appState === AppState.IDLE && <Radio size={48} className="text-gray-500" />}
            
            {/* Monitoring */}
            {appState === AppState.MONITORING && maxScore <= 50 && <Activity size={48} className="text-green-500 animate-pulse" />}
            {appState === AppState.MONITORING && maxScore > 50 && <AlertTriangle size={48} className="text-yellow-500 animate-pulse" />}
            
            {/* Verifying */}
            {appState === AppState.ANALYZING && <BrainCircuit size={48} className="text-blue-400 animate-pulse" />}
            
            {/* Confirmed */}
            {appState === AppState.CYCLE_ACTIVE && confirmedType === 'FIRE_ALARM' && <Flame size={48} className="text-red-500 animate-bounce" />}
            {appState === AppState.CYCLE_ACTIVE && confirmedType === 'SCREAM' && <Megaphone size={48} className="text-orange-500 animate-bounce" />}
          </div>
          
          <h2 className="text-2xl font-bold mb-1">
            {appState === AppState.IDLE && "系統待機"}
            {appState === AppState.MONITORING && maxScore <= 50 && "監控中..."}
            {appState === AppState.MONITORING && maxScore > 50 && (fireScore > screamScore ? '疑似火災警報' : '疑似求救聲')}
            {appState === AppState.ANALYZING && "AI 分析聲音中..."}
            {appState === AppState.CYCLE_ACTIVE && (confirmedType === 'FIRE_ALARM' ? "🔥 確認：火災警報" : "🗣️ 確認：人員求救")}
            {appState === AppState.COOLDOWN && "冷卻中"}
          </h2>
          
          <p className="text-gray-400 text-sm font-mono mt-2">
            {appState === AppState.ANALYZING && "正在錄音並傳送至 Gemini..."}
            {appState === AppState.CYCLE_ACTIVE && `正在上傳第 ${photoCount}/${TOTAL_PHOTOS} 次回報...`}
            {appState === AppState.MONITORING && `音量: ${Math.round(audioLevel)}% | 火警特徵: ${Math.round(fireScore)}%`}
          </p>

          {/* Feedback for False Alarms */}
          {lastAnalysis && (appState === AppState.MONITORING || appState === AppState.COOLDOWN) && (
            <div className={`mt-4 p-2 rounded-lg text-xs border ${appState === AppState.COOLDOWN ? 'bg-red-900/30 border-red-800 text-red-200' : 'bg-gray-800/50 border-gray-700 text-gray-300'}`}>
               {lastAnalysis}
            </div>
          )}

          {/* Visualizer & Bars */}
          {(appState === AppState.MONITORING || appState === AppState.ANALYZING) && (
            <div className="mt-6 space-y-3">
              <Visualizer level={audioLevel} threshold={config.sensitivity} triggered={maxScore > 0} />
              
              {maxScore > 0 && (
                <div className="flex gap-2 text-xs">
                  <div className="flex-1">
                    <div className="flex justify-between mb-1 text-red-400"><span>火警特徵</span><span>{Math.round(fireScore)}%</span></div>
                    <div className="bg-gray-800 h-1 rounded-full overflow-hidden"><div className="bg-red-500 h-full transition-all" style={{width: `${fireScore}%`}}></div></div>
                  </div>
                  <div className="flex-1">
                    <div className="flex justify-between mb-1 text-orange-400"><span>尖叫特徵</span><span>{Math.round(screamScore)}%</span></div>
                    <div className="bg-gray-800 h-1 rounded-full overflow-hidden"><div className="bg-orange-500 h-full transition-all" style={{width: `${screamScore}%`}}></div></div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Camera Feed */}
        <div className="relative rounded-2xl overflow-hidden bg-black aspect-video border border-gray-800 shadow-lg">
          <video ref={videoRef} autoPlay playsInline muted className={`w-full h-full object-cover ${!showCamera ? 'opacity-0' : 'opacity-100'}`} />
          {!showCamera && <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm">相機運作中 (畫面隱藏)</div>}
          
          {appState === AppState.ANALYZING && (
              <div className="absolute top-2 left-2 bg-red-600 text-white text-xs px-2 py-1 rounded animate-pulse flex items-center gap-1">
                  <Mic size={12} /> 錄音中 (4s)
              </div>
          )}
          
          {/* Heartbeat Indicator (Brief flash) */}
          {config.heartbeatInterval > 0 && appState === AppState.MONITORING && (
               <div className="absolute top-2 right-2 flex items-center gap-1 bg-black/50 text-white/50 text-[10px] px-2 py-1 rounded-full">
                  <Camera size={10} /> 定時監控: {config.heartbeatInterval}m
               </div>
          )}

          <button onClick={() => setShowCamera(!showCamera)} className="absolute bottom-2 right-2 bg-black/50 p-2 rounded-full text-white backdrop-blur-sm">
            {showCamera ? <Eye size={16} /> : <EyeOff size={16} />}
          </button>
        </div>

        {/* Action Button */}
        {appState === AppState.IDLE ? (
          <div className="space-y-3">
            <button onClick={startMonitoring} className="w-full py-4 rounded-xl font-bold text-lg bg-white text-black hover:bg-gray-200 transition active:scale-95 shadow-lg shadow-white/10">啟動監控</button>
            <div className="flex items-center justify-center gap-2 text-xs text-gray-500"><BatteryCharging size={14} /><span>請連接電源並保持螢幕開啟</span></div>
          </div>
        ) : (
          <button onClick={stopMonitoring} className="w-full py-4 rounded-xl font-bold text-lg bg-red-900/50 text-red-200 border border-red-800 hover:bg-red-900/70 transition active:scale-95">停止監控 / 解除</button>
        )}

        {/* Logs Console */}
        <div className="flex-1 bg-surface border border-gray-800 rounded-2xl p-4 overflow-hidden flex flex-col min-h-[150px]">
          <h3 className="text-xs font-bold text-gray-500 uppercase mb-2 tracking-wider">系統日誌</h3>
          <div className="flex-1 overflow-y-auto space-y-2 pr-1 font-mono text-xs">
            {logs.map(log => (
              <div key={log.id} className={`flex gap-2 ${log.type === 'error' ? 'text-red-400' : log.type === 'alert' ? 'text-yellow-400' : log.type === 'success' ? 'text-green-400' : 'text-gray-400'}`}>
                <span className="opacity-50">[{new Date(log.timestamp).toLocaleTimeString([], {hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit'})}]</span>
                <span>{log.message}</span>
              </div>
            ))}
          </div>
        </div>
      </main>

      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} config={config} setConfig={setConfig} />
    </div>
  );
}