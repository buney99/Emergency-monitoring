import { GoogleGenAI } from "@google/genai";

interface AnalysisResult {
  category: 'FIRE_ALARM' | 'SCREAM' | 'FALSE_ALARM' | 'RATE_LIMIT';
  description: string;
  confidence: number;
}

export const analyzeEventContext = async (
  imageBlob: Blob, 
  audioBlob: Blob | null,
  locationName: string
): Promise<AnalysisResult> => {
  // Access API key strictly via process.env.API_KEY as per guidelines
  const apiKey = process.env.API_KEY;

  if (!apiKey) {
    console.error("Missing API Key in environment variables.");
    return { 
      category: 'FALSE_ALARM', 
      description: "系統錯誤: 未設定 API Key (環境變數)。", 
      confidence: 0 
    };
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    
    // Check if image is valid
    if (!imageBlob || imageBlob.size === 0) {
      throw new Error("影像資料無效或為空。");
    }

    // Convert Image to Base64
    const imageBase64 = await blobToBase64(imageBlob);
    
    // Prepare parts
    const parts: any[] = [
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: imageBase64
        }
      }
    ];

    // Convert Audio to Base64 (Only if available AND has sufficient data)
    // 1KB threshold prevents sending empty containers
    if (audioBlob && audioBlob.size > 1024) {
      try {
        const audioBase64 = await blobToBase64(audioBlob);
        if (audioBase64 && audioBase64.length > 0) {
          // Use the type directly (AudioEngine now ensures it's audio/wav)
          // Fallback to audio/wav if missing
          const cleanMimeType = audioBlob.type || 'audio/wav';
          
          parts.push({
            inlineData: {
              mimeType: cleanMimeType,
              data: audioBase64
            }
          });
        }
      } catch (e) {
        console.warn("音訊處理失敗，僅發送影像。", e);
      }
    }

    // System Instruction: 定義角色與嚴格的判斷邏輯
    const systemInstruction = `
你是一個高精度的「音訊事件分析專家」。你的任務是監聽緊急監控系統的錄音，並結合現場畫面，判斷是否發生了極度危險的事件。

【核心原則】：
1. **聲音是最高指導原則**。相機畫面經常有死角，若聲音明確顯示有危機，即使畫面一片祥和，也要判定為危機。
2. **排除誤報 (False Positives) 是關鍵**。不要將普通的噪音（如狗叫、小孩嬉鬧、汽車喇叭、施工聲）誤判為緊急事件。
3. **精確分類**：
   - FIRE_ALARM (火災警報)：必須是「機械性」、「重複性」、「高頻」的聲音。
   - SCREAM (求救)：必須是「極度恐懼」、「痛苦」、「失控」的人聲。

【類別定義與聲學特徵】：

A. [FIRE_ALARM] (火災警報)
   - 聲學特徵：聲音具有高度的規律性 (Temporal Regularity)。
   - 典型模式：連續的嗶-嗶-嗶 (Beep pattern)、持續的高頻長音、既定的消防廣播。
   - ❌ 排除：倒車雷達 (較短促且單一)、微波爐聲、手機鈴聲 (旋律性太強)、汽車防盜器 (通常會忽大忽小)。

B. [SCREAM] (人員求救)
   - 聲學特徵：具有極強的情緒張力，非正常的說話頻率。
   - 典型模式：喊「救命」、「好痛」、或非語言的淒厲尖叫 (高分貝、破音)。
   - ❌ 排除：小孩玩耍的尖叫 (通常帶有笑意或短促)、憤怒的吵架 (通常是語意連貫的謾罵)、狗吠聲。

C. [FALSE_ALARM] (誤報)
   - 所有不符合上述極端特徵的聲音。包含：電視聲、施工電鑽聲、物品掉落聲、正常的交談、笑聲。
`;

    // User Prompt: 執行分析指令
    const prompt = `
      地點： "${locationName}"。
      
      請執行以下分析步驟 (Chain of Thought)：
      1. **聲學分析**：這段聲音是「規律的機械音」還是「不規律的生物音」？是否有特定的警報節奏？
      2. **語意分析**：若有人聲，是在喊「救命/火災」還是普通的對話/吵架？
      3. **畫面確認**：畫面中是否有明顯的火光、煙霧或倒地的人？(若無，請完全依賴聲音判斷)。
      4. **排除測試**：這有沒有可能是電視聲、狗叫聲或小孩玩鬧？

      請根據上述分析，輸出最終 JSON 結果。
    `;

    parts.push({ text: prompt });

    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash', 
      contents: { parts },
      config: {
        systemInstruction: systemInstruction,
        responseMimeType: "application/json",
        temperature: 0.1, // 降低隨機性，追求穩定準確
        topK: 1, // 只取機率最高的結果
      }
    });

    let text = response.text;
    if (!text) throw new Error("AI 回傳空值");

    // Sanitize JSON (Remove markdown code blocks if present)
    text = text.replace(/```json/g, '').replace(/```/g, '').trim();

    const result = JSON.parse(text) as AnalysisResult;
    return result;

  } catch (error: any) {
    console.error("Gemini Analysis Failed:", error);
    
    // Check for Rate Limit (429) errors
    const errorMessage = error.message || error.toString();
    if (errorMessage.includes('429') || errorMessage.includes('RESOURCE_EXHAUSTED')) {
        return {
            category: 'RATE_LIMIT',
            description: "API 配額耗盡 (429)，系統將暫時冷卻。",
            confidence: 0
        };
    }

    return {
      category: 'FALSE_ALARM',
      description: `AI 分析失敗: ${errorMessage.substring(0, 100)}...`,
      confidence: 0
    };
  }
};

const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      if (result && result.includes(',')) {
        const base64 = result.split(',')[1];
        resolve(base64);
      } else {
        resolve("");
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};