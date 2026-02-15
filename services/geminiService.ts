
import { GoogleGenAI } from "@google/genai";

interface AnalysisResult {
  category: 'FIRE_ALARM' | 'SCREAM' | 'FALSE_ALARM' | 'RATE_LIMIT';
  description: string;
  confidence: number;
}

/**
 * 輔助函數：將 Blob 轉換為 Base64 字串
 */
const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      if (result && result.includes(',')) {
        resolve(result.split(',')[1]);
      } else {
        resolve("");
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

export const analyzeEventContext = async (
  imageBlob: Blob, 
  audioBlob: Blob | null,
  locationName: string
): Promise<AnalysisResult> => {
  const apiKey = process.env.API_KEY;

  if (!apiKey) {
    console.error("Missing API Key in environment variables.");
    return { 
      category: 'FALSE_ALARM', 
      description: "系統錯誤: 未設定 API Key。", 
      confidence: 0 
    };
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    
    if (!imageBlob || imageBlob.size === 0) {
      throw new Error("影像資料無效。");
    }

    const imageBase64 = await blobToBase64(imageBlob);
    
    const parts: any[] = [
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: imageBase64
        }
      }
    ];

    if (audioBlob && audioBlob.size > 1024) {
      try {
        const audioBase64 = await blobToBase64(audioBlob);
        if (audioBase64) {
          parts.push({
            inlineData: {
              mimeType: audioBlob.type || 'audio/wav',
              data: audioBase64
            }
          });
        }
      } catch (e) {
        console.warn("音訊處理失敗，僅發送影像分析。", e);
      }
    }

    const systemInstruction = `
你是一個高精度的「多模態安全專家」。你的任務是結合錄音與現場畫面，判斷是否發生危險。

【判定準則】：
1. 聲音優先：警報器或淒厲慘叫即使在畫面外也要報警。
2. 排除誤報：
   - FIRE_ALARM：機械規律嗶聲 (Beep-Beep-Beep)。
   - SCREAM：極度恐懼、失控的人聲 (救命、淒厲尖叫)。
3. 若非上述，一律判定為 FALSE_ALARM。

請輸出 JSON 格式。
`;

    const prompt = `地點：「${locationName}」。請分析提供的影像與音訊，判斷是否有火警或求救事件。`;

    parts.push({ text: prompt });

    // 使用 gemini-3-flash-preview 模型
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview', 
      contents: { parts },
      config: {
        systemInstruction: systemInstruction,
        responseMimeType: "application/json",
        temperature: 0.1,
      }
    });

    const text = response.text;
    if (!text) throw new Error("AI 回傳空值");

    const sanitizedText = text.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(sanitizedText) as AnalysisResult;

  } catch (error: any) {
    console.error("Gemini Analysis Failed:", error);
    
    const errorMessage = error.message || error.toString();
    if (errorMessage.includes('429') || errorMessage.includes('RESOURCE_EXHAUSTED')) {
        return {
            category: 'RATE_LIMIT',
            description: "API 配額耗盡。",
            confidence: 0
        };
    }

    return {
      category: 'FALSE_ALARM',
      description: `分析失敗: ${errorMessage.substring(0, 50)}`,
      confidence: 0
    };
  }
};
