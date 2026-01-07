import React from 'react';
import { MonitorConfig } from '../types';
import { PlayCircle, AlertTriangle } from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: MonitorConfig;
  setConfig: React.Dispatch<React.SetStateAction<MonitorConfig>>;
  onTestWebhook?: () => void;
  onSimulateAlarm?: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ 
  isOpen, onClose, config, setConfig, onTestWebhook, onSimulateAlarm 
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="bg-surface border border-gray-700 w-full max-w-md rounded-2xl p-6 shadow-2xl overflow-y-auto max-h-[90vh]">
        <h2 className="text-xl font-bold text-white mb-6">系統設定</h2>
        
        <div className="space-y-4">
          <div>
            <label className="block text-gray-400 text-sm mb-1">地點名稱 / 裝置 ID</label>
            <input 
              type="text" 
              value={config.locationName}
              onChange={(e) => setConfig(prev => ({ ...prev, locationName: e.target.value }))}
              placeholder="例如：客廳、B棟倉庫"
              className="w-full bg-black border border-gray-700 rounded-lg p-3 text-white focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-gray-400 text-sm mb-1">Webhook 網址 (POST)</label>
            <div className="flex gap-2">
                <input 
                type="url" 
                value={config.webhookUrl}
                onChange={(e) => setConfig(prev => ({ ...prev, webhookUrl: e.target.value }))}
                placeholder="https://your-server.com/webhook"
                className="flex-1 bg-black border border-gray-700 rounded-lg p-3 text-white focus:border-blue-500 focus:outline-none"
                />
            </div>
            <div className="flex justify-end mt-2">
                {onTestWebhook && (
                    <button 
                        onClick={onTestWebhook}
                        disabled={!config.webhookUrl}
                        className="text-xs px-3 py-1 bg-gray-800 hover:bg-gray-700 text-blue-400 rounded border border-gray-600 transition-colors disabled:opacity-50"
                    >
                        測試連線
                    </button>
                )}
            </div>
          </div>

          <div>
            <label className="block text-gray-400 text-sm mb-1">觸發靈敏度 ({config.sensitivity}%)</label>
            <input 
              type="range" 
              min="10" 
              max="90" 
              value={config.sensitivity}
              onChange={(e) => setConfig(prev => ({ ...prev, sensitivity: Number(e.target.value) }))}
              className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>低靈敏度 (不易觸發)</span>
              <span>高靈敏度 (容易觸發)</span>
            </div>
          </div>

          <div>
            <label className="block text-gray-400 text-sm mb-1">定時監控快照 ({config.heartbeatInterval === 0 ? '已關閉' : `每 ${config.heartbeatInterval} 分鐘`})</label>
            <input 
              type="range" 
              min="0" 
              max="60"
              step="1" 
              value={config.heartbeatInterval || 0}
              onChange={(e) => setConfig(prev => ({ ...prev, heartbeatInterval: Number(e.target.value) }))}
              className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>關閉</span>
              <span>每 60 分鐘</span>
            </div>
          </div>

          <div className="pt-2 border-t border-gray-800">
            <label className="flex items-center space-x-3 cursor-pointer">
              <input 
                type="checkbox" 
                checked={config.useGeminiAnalysis}
                onChange={(e) => setConfig(prev => ({ ...prev, useGeminiAnalysis: e.target.checked }))}
                className="w-5 h-5 rounded border-gray-700 bg-black checked:bg-blue-600"
              />
              <span className="text-white">啟用 AI 分析 (Gemini)</span>
            </label>
          </div>

          {onSimulateAlarm && (
            <div className="pt-4 border-t border-gray-800">
               <label className="block text-gray-400 text-sm mb-2">危險操作區域</label>
               <button 
                 onClick={onSimulateAlarm}
                 className="w-full flex items-center justify-center gap-2 py-3 bg-red-900/30 border border-red-800 text-red-400 rounded-lg hover:bg-red-900/50 transition-colors"
               >
                 <PlayCircle size={18} />
                 模擬觸發演練 (Drill)
               </button>
               <p className="text-xs text-gray-500 mt-1 text-center">
                 將直接執行「尖叫偵測」後的警報流程 (含拍照、錄音、上傳)。
               </p>
            </div>
          )}
        </div>

        <button 
          onClick={onClose}
          className="mt-6 w-full bg-white text-black font-bold py-3 rounded-lg hover:bg-gray-200 transition-colors"
        >
          儲存並關閉
        </button>
      </div>
    </div>
  );
};