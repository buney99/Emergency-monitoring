import React from 'react';

interface VisualizerProps {
  level: number;
  threshold: number;
  triggered: boolean;
}

export const Visualizer: React.FC<VisualizerProps> = ({ level, threshold, triggered }) => {
  // Map sensitivity (10-90) to a display threshold. 
  // If sensitivity is 80 (high), the bar threshold should be low (e.g. 20).
  // Threshold logic: Trigger if level > (100 - sensitivity).
  const displayThreshold = 100 - threshold;

  return (
    <div className="w-full h-4 bg-gray-800 rounded-full overflow-hidden relative mt-2">
      {/* Background Track */}
      
      {/* Threshold Marker */}
      <div 
        className="absolute top-0 bottom-0 w-1 bg-yellow-500 z-10"
        style={{ left: `${displayThreshold}%` }}
      />
      
      {/* Active Level Bar */}
      <div 
        className={`h-full transition-all duration-100 ease-out ${triggered ? 'bg-alert' : 'bg-safe'}`}
        style={{ width: `${Math.min(100, level)}%` }}
      />
    </div>
  );
};