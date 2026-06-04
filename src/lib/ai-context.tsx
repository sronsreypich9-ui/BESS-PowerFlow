import React, { createContext, useContext, useState, useEffect } from 'react';
import { GoogleGenAI } from "@google/genai";

interface AIContextProps {
  provider: 'gemini' | 'chatgpt' | 'claude';
  setProvider: (p: 'gemini' | 'chatgpt' | 'claude') => void;
  apiKey: string;
  setApiKey: (key: string) => void;
  language: 'English' | 'Khmer';
  setLanguage: (lang: 'English' | 'Khmer') => void;
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
  setConnectionStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void;
  systemInstructions: string;
  setSystemInstructions: (inst: string) => void;
  handleConnect: () => Promise<void>;
  handleDisconnect: () => void;
  messages: {role: 'user' | 'assistant', content: string, image?: string}[];
  setMessages: React.Dispatch<React.SetStateAction<{role: 'user' | 'assistant', content: string, image?: string}[]>>;
  clearHistory: () => void;
}

export const AIContext = createContext<AIContextProps | null>(null);

export function AIProvider({ children }: { children: React.ReactNode }) {
  const [provider, setProvider] = useState<'gemini' | 'chatgpt' | 'claude'>(
    (localStorage.getItem('ai_provider') as 'gemini' | 'chatgpt' | 'claude') || 'gemini'
  );
  
  const [language, setLanguage] = useState<'English' | 'Khmer'>(
    (localStorage.getItem('ai_language') as 'English' | 'Khmer') || 'English'
  );
  
  const [apiKey, setApiKey] = useState(localStorage.getItem('ai_api_key') || '');
  
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>(
    (localStorage.getItem('ai_connection_status') as 'disconnected' | 'connecting' | 'connected' | 'error') || 'disconnected'
  );
  
  const [systemInstructions, setSystemInstructions] = useState(
    localStorage.getItem('ai_system_instructions') || 
`You are an intelligent engineering assistant for the power and energy industry. You specialize in Electrical Grid Systems, Solar Farm Monitoring & Optimization, EMS, SCADA Integration, BESS, Renewable Energy Analytics, Power Dispatch, Grid Stability, and Industrial IoT.

You understand OT, energy infrastructure, industrial communication protocols (IEC 61850, Modbus, DNP3), and large-scale energy data systems. You can analyze uploaded images of chart history, telemetry tables, or SCADA screens.`
  );

  useEffect(() => {
    localStorage.setItem('ai_provider', provider);
  }, [provider]);

  useEffect(() => {
    localStorage.setItem('ai_language', language);
  }, [language]);

  useEffect(() => {
    localStorage.setItem('ai_api_key', apiKey);
  }, [apiKey]);
  
  useEffect(() => {
    localStorage.setItem('ai_connection_status', connectionStatus);
  }, [connectionStatus]);

  useEffect(() => {
    localStorage.setItem('ai_system_instructions', systemInstructions);
  }, [systemInstructions]);
  
  const initialGreeting = language === 'Khmer' ? 'ការតភ្ជាប់បានជោគជ័យ។ ត្រៀមខ្លួនជាស្រេចក្នុងការវិភាគទិន្នន័យ។' : 'Connection established. Ready to analyze data.';
  
  const [messages, setMessages] = useState<{role: 'user' | 'assistant', content: string, image?: string}[]>([
    { role: 'assistant', content: initialGreeting }
  ]);

  const clearHistory = () => {
    setMessages([{ role: 'assistant', content: language === 'Khmer' ? 'ការតភ្ជាប់បានជោគជ័យ។ ត្រៀមខ្លួនជាស្រេចក្នុងការវិភាគទិន្នន័យ។' : 'Connection established. Ready to analyze data.' }]);
  };

  const handleConnect = async () => {
      if (!apiKey) {
          setConnectionStatus('error');
          setMessages(prev => [...prev, { role: 'assistant', content: `Please enter an API Key to test connection.` }]);
          return;
      }
      setConnectionStatus('connecting');
      try {
          if (provider === 'gemini') {
              const ai = new GoogleGenAI({ apiKey: apiKey });
              await ai.models.generateContent({
                  model: 'gemini-3-flash-preview',
                  contents: [{ role: 'user', parts: [{ text: 'Hello' }] }]
              });
              setConnectionStatus('connected');
              setMessages(prev => [...prev, { role: 'assistant', content: language === 'Khmer' ? `បានភ្ជាប់ជាមួយ GEMINI API ដោយជោគជ័យ។` : `Successfully connected to GEMINI API.` }]);
          } else {
              setTimeout(() => {
                  setConnectionStatus('connected');
                  setMessages(prev => [...prev, { role: 'assistant', content: `Mock connected to ${provider.toUpperCase()} API.` }]);
              }, 1000);
          }
      } catch (err: any) {
          console.error("Connection error:", err);
          setConnectionStatus('error');
          setMessages(prev => [...prev, { role: 'assistant', content: `Failed to connect to ${provider.toUpperCase()} API. Details: ${err?.message || 'Unknown error'}` }]);
      }
  };

  const handleDisconnect = () => {
    setConnectionStatus('disconnected');
    setMessages(prev => [...prev, { role: 'assistant', content: language === 'Khmer' ? 'បានផ្តាច់ការតភ្ជាប់។' : 'Disconnected from API.' }]);
  };

  return (
    <AIContext.Provider value={{
      provider, setProvider,
      apiKey, setApiKey,
      language, setLanguage,
      connectionStatus, setConnectionStatus,
      systemInstructions, setSystemInstructions,
      handleConnect, handleDisconnect,
      messages, setMessages,
      clearHistory
    }}>
      {children}
    </AIContext.Provider>
  );
}

export const useAIContext = () => {
  const context = useContext(AIContext);
  if (!context) throw new Error("useAIContext must be used within AIProvider");
  return context;
};
