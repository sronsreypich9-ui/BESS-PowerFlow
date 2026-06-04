import React, { useState, useEffect, useRef } from 'react';
import { Bot, Send, Loader2, User, ImagePlus, X, Trash2, Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { GoogleGenAI } from "@google/genai";
import Markdown from 'react-markdown';
import { useAIContext } from '../lib/ai-context';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function AIAgent() {
  const { provider, apiKey, systemInstructions, connectionStatus, messages, setMessages, clearHistory, language, setLanguage } = useAIContext();
  
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [attachment, setAttachment] = useState<{data: string, mimeType: string} | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  
  const [project, setProject] = useState('SNTB 30MWH');
  const [plant, setPlant] = useState('plant1');

  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    // Only accept images
    if (!file.type.startsWith('image/')) {
        alert(language === 'Khmer' ? 'សូមជ្រើសរើសឯកសាររូបភាពដើម្បីវិភាគ។' : 'Please select an image file to analyze.');
        return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
        const base64withMeta = event.target?.result as string;
        // e.g. data:image/png;base64,iVBORw0K...
        const parts = base64withMeta.split(',');
        const mimeType = parts[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
        const base64Data = parts[1];
        setAttachment({ data: base64Data, mimeType });
    };
    reader.readAsDataURL(file);
    
    // Reset input
    if (fileInputRef.current) {
        fileInputRef.current.value = '';
    }
  };

  const handleSendMessage = async () => {
    if (!inputMessage.trim() && !attachment) return;
    
    const newUserMessage = { 
        role: 'user' as const, 
        content: inputMessage.trim(),
        image: attachment ? `data:${attachment.mimeType};base64,${attachment.data}` : undefined
    };
    
    setMessages(prev => [...prev, newUserMessage]);
    setInputMessage('');
    setAttachment(null);
    setIsLoading(true);
    
    try {
      if (provider === 'gemini') {
        if (!apiKey) throw new Error("API Key is missing. Please configure it in settings.");
        
        const ai = new GoogleGenAI({ apiKey: apiKey });
        
        // Filter out initial welcome message and ensure alternate turns
        const apiMessages = messages.filter(m => !m.content.includes("Connection established") && !m.content.includes("ការតភ្ជាប់បានជោគជ័យ") && !m.content.includes("Successfully connected") && !m.content.includes("បានភ្ជាប់ជាមួយ"));
        
        const langInstruction = language === 'Khmer' ? "You MUST respond in Khmer." : "You MUST respond in English.";
        
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: apiMessages.concat(newUserMessage).map(msg => {
                const parts: any[] = [];
                if (msg.content) {
                    parts.push({ text: msg.content });
                }
                if (msg.image) {
                     const mimeType = msg.image.match(/data:(.*?);base64,/)?.[1] || 'image/jpeg';
                     const b64 = msg.image.split(',')[1];
                     parts.push({
                        inlineData: {
                            mimeType,
                            data: b64
                        }
                     });
                }
                return {
                    role: msg.role === 'assistant' ? 'model' : 'user',
                    parts: parts
                };
            }),
            config: {
                systemInstruction: systemInstructions + "\n\n" + langInstruction + `\n\nContext: The user is currently analyzing data for Project: ${project}, Plant: ${plant}.`
            }
        });
        
        if (response.text !== undefined) {
           setMessages(prev => [...prev, { role: 'assistant', content: response.text as string }]);
        } else {
           setMessages(prev => [...prev, { role: 'assistant', content: language === "Khmer" ? "មានកំហុសក្នុងការទាញយកចម្លើយ។" : "An error occurred fetching response." }]);
        }

      } else {
        // Fallback for demo for other APIs since we don't have their SDKs installed
        setTimeout(() => {
          setMessages(prev => [...prev, { 
            role: 'assistant', 
            content: `Connected to ${provider.toUpperCase()} API. (Note: Only Gemini has full SDK integration in this demo, but the fetch logic for ${provider} can be enabled here.)` 
          }]);
          setIsLoading(false);
        }, 1500);
        return;
      }
    } catch (error: any) {
      console.error(error);
      setMessages(prev => [...prev, { role: 'assistant', content: (language === "Khmer" ? `មានកំហុស៖ ` : `Error communicating with API: `) + (error?.message || "Unknown error") }]);
    } finally {
      setIsLoading(false);
    }
  };

  // Get the most recent assistant message that is not a connection message
  const lastValidMessage = [...messages].reverse().find(
    m => m.role === 'assistant' && 
    !m.content.includes("Connection established") && 
    !m.content.includes("ការតភ្ជាប់បានជោគជ័យ") && 
    !m.content.includes("Successfully connected") && 
    !m.content.includes("Mock connected")
  );

  return (
    <section className="flex-1 min-h-0 bg-panel border border-border-v rounded-sm flex flex-col lg:flex-row relative overflow-hidden">
      {/* Left Chat Interface */}
      <div className="flex-1 lg:max-w-[45%] flex flex-col bg-background shadow-inner relative min-w-0 border-r border-border-v">
        <div className="px-4 py-3 flex items-start justify-between border-b border-border-v bg-surface/50 shrink-0">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3">
              <div className="font-bold text-[11px] uppercase tracking-wider flex items-center gap-2">
                <Bot size={14} className={cn(provider === 'gemini' ? "text-accent-blue" : provider === 'chatgpt' ? "text-green-500" : "text-orange-500")} />
                AI Analytical Assistant <span className="opacity-50">({provider.toUpperCase()})</span>
              </div>
              
              <div className="flex flex-wrap items-end gap-3 mt-1">
                <div className="flex flex-col gap-1.5 w-[140px] shrink-0">
                  <span className="text-[10px] uppercase font-bold tracking-widest text-foreground/40">LANGUAGE MODE</span>
                  <div className="flex bg-background rounded-md border border-border-v p-0.5 h-7">
                    <button 
                      onClick={() => setLanguage('English')}
                      className={cn("flex-1 h-full rounded transition-all text-[11px] font-medium flex items-center justify-center", language === 'English' ? "bg-accent-blue text-white shadow-sm" : "text-foreground/60 hover:text-foreground")}
                    >
                      English
                    </button>
                    <button 
                      onClick={() => setLanguage('Khmer')}
                      className={cn("flex-1 h-full rounded transition-all text-[11px] font-khmer font-medium flex items-center justify-center", language === 'Khmer' ? "bg-accent-blue text-white shadow-sm" : "text-foreground/60 hover:text-foreground")}
                    >
                      ខ្មែរ
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <div className="flex flex-col gap-1.5 shrink-0">
                    <span className="text-[10px] uppercase font-bold tracking-widest text-foreground/40">PROJECT</span>
                    <Select value={project} onValueChange={setProject}>
                      <SelectTrigger className="h-7 text-[11px] bg-foreground/5 border-foreground/10 text-foreground focus:ring-0 focus:ring-offset-0 w-[150px]">
                        <SelectValue placeholder="Select Project" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="SNTB 30MWH" className="text-[11px] font-bold">SNTB 30MWH</SelectItem>
                        <SelectItem value="SNTV 12MWH" className="text-[11px] font-bold">SNTV 12MWH</SelectItem>
                        <SelectItem value="SNTD-DMF 18MWH" className="text-[11px] font-bold">SNTD-DMF 18MWH</SelectItem>
                        <SelectItem value="SNTZ 3MWH" className="text-[11px] font-bold">SNTZ 3MWH</SelectItem>
                        <SelectItem value="MSGP 14MWH" className="text-[11px] font-bold">MSGP 14MWH</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex flex-col gap-1.5 shrink-0">
                    <span className="text-[10px] uppercase font-bold tracking-widest text-foreground/40">PLANT</span>
                    <Select value={plant} onValueChange={setPlant}>
                      <SelectTrigger className="h-7 text-[11px] bg-foreground/5 border-foreground/10 text-foreground focus:ring-0 focus:ring-offset-0 w-[90px]">
                        <SelectValue placeholder="Select Plant" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="plant1" className="text-[11px]">Plant 1</SelectItem>
                        <SelectItem value="plant2" className="text-[11px]">Plant 2</SelectItem>
                        {project !== 'SNTB 30MWH' && (
                          <SelectItem value="plant3" className="text-[11px]">Plant 3</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          <div className="flex flex-col items-end gap-4">
             <div className="flex items-center gap-2 text-[10px] uppercase font-mono tracking-widest text-foreground/50 shrink-0">
               {connectionStatus === 'connected' ? <><span className="h-1.5 w-1.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.8)]"></span> Connected</> :
                connectionStatus === 'error' ? <><span className="h-1.5 w-1.5 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)]"></span> Error</> :
                connectionStatus === 'connecting' ? <><span className="h-1.5 w-1.5 rounded-full bg-yellow-500 animate-pulse"></span> Connecting...</> :
                <><span className="h-1.5 w-1.5 rounded-full bg-foreground/30"></span> Disconnected</>}
             </div>
             {messages.length > 1 && (
                 <button 
                   onClick={clearHistory}
                   className="text-[10px] uppercase font-mono tracking-widest text-red-500 hover:text-red-400 transition-colors flex items-center gap-1 bg-red-500/10 hover:bg-red-500/20 px-2 py-1.5 rounded border border-red-500/20"
                   title="Clear History"
                 >
                   <Trash2 size={12} /> <span className="hidden sm:inline">{language === 'Khmer' ? 'លុបប្រវត្តិ' : 'Clear History'}</span>
                 </button>
             )}
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 md:p-6 flex flex-col gap-6 w-full max-w-5xl mx-auto">
          {messages.map((msg, idx) => (
            <div key={idx} className={cn("flex gap-4 w-full group", msg.role === 'user' ? "flex-row-reverse" : "flex-row")}>
              <div className="shrink-0 h-8 w-8 rounded-full flex items-center justify-center border border-border-v" style={{ backgroundColor: msg.role === 'user' ? 'rgba(var(--foreground-rgb), 0.05)' : msg.role === 'assistant' && provider === 'gemini' ? 'rgba(0,163,255,0.1)' : msg.role === 'assistant' && provider === 'chatgpt' ? 'rgba(34,197,94,0.1)' : 'rgba(249,115,22,0.1)' }}>
                {msg.role === 'user' ? <User size={14} className="text-foreground/60" /> : <Bot size={14} className={cn(provider === 'gemini' ? "text-accent-blue" : provider === 'chatgpt' ? "text-green-500" : "text-orange-500")} />}
              </div>
              <div className={cn("flex flex-col gap-1 w-full", msg.role === 'user' ? "items-end max-w-[80%]" : "items-start min-w-0 flex-1")}>
                <div className={cn("flex items-center w-full", msg.role === 'user' ? "justify-end" : "justify-between")}>
                  <span className="text-[10px] text-foreground/40 font-mono font-medium tracking-wide">
                    {msg.role === 'user' ? 'YOU' : provider.toUpperCase()}
                  </span>
                  {msg.role === 'assistant' && (
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(msg.content);
                        setCopiedIndex(idx);
                        setTimeout(() => setCopiedIndex(null), 2000);
                      }}
                      className={cn("text-foreground/40 hover:text-foreground transition-opacity flex items-center gap-1 text-[10px] uppercase font-bold", copiedIndex === idx ? "opacity-100 text-green-500" : "opacity-0 group-hover:opacity-100")}
                      title="Copy response"
                    >
                      {copiedIndex === idx ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
                    </button>
                  )}
                </div>
                <div className={cn("px-4 py-3 rounded-2xl text-[13px] leading-relaxed flex flex-col gap-2 w-full", msg.role === 'user' ? "bg-surface border border-border-v/50 text-foreground/90 rounded-tr-sm" : "bg-transparent text-foreground")}>
                  {msg.role === 'user' ? (
                    <>
                      {msg.image && (
                         <div className="relative group rounded overflow-hidden max-w-xs border border-border-v self-end bg-background/50">
                            <img src={msg.image} alt="Uploaded chart" className="w-full h-auto max-h-[300px] object-contain" />
                         </div>
                      )}
                      {msg.content && <span>{msg.content}</span>}
                    </>
                  ) : (
                    <div className="markdown-body">
                      <Markdown>{msg.content}</Markdown>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="flex gap-4 w-full">
               <div className="shrink-0 h-8 w-8 rounded-full flex items-center justify-center border border-border-v" style={{ backgroundColor: provider === 'gemini' ? 'rgba(0,163,255,0.1)' : provider === 'chatgpt' ? 'rgba(34,197,94,0.1)' : 'rgba(249,115,22,0.1)' }}>
                  <Bot size={14} className={cn(provider === 'gemini' ? "text-accent-blue" : provider === 'chatgpt' ? "text-green-500" : "text-orange-500")} />
               </div>
               <div className="flex items-center text-foreground/50 gap-2 px-2 h-8">
                 <Loader2 size={12} className="animate-spin" />
                 <span className="text-[11px] font-mono animate-pulse">{language === 'Khmer' ? 'កំពុងវិភាគទិន្នន័យបណ្តាញអគ្គិសនី...' : 'Analyzing grid telemetry...'}</span>
               </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
        
        {/* Input Area */}
        <div className="p-4 border-t border-border-v bg-background shrink-0 flex justify-center w-full">
           <div className="w-full max-w-4xl relative flex flex-col">
              {attachment && (
                  <div className="mb-2 w-fit relative bg-surface border border-border-v rounded p-1 group">
                      <img src={`data:${attachment.mimeType};base64,${attachment.data}`} className="h-16 w-auto rounded object-contain" alt="Attachment Preview" />
                      <button onClick={() => setAttachment(null)} className="absolute -top-2 -right-2 h-5 w-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                         <X size={12} />
                      </button>
                  </div>
              )}
              <div className="relative flex items-end w-full border border-border-v rounded-xl bg-surface/50 focus-within:border-accent-blue/50 focus-within:ring-1 focus-within:ring-accent-blue/20 transition-all p-1.5">
                 <button onClick={() => fileInputRef.current?.click()} className="shrink-0 self-end h-[36px] w-[36px] flex items-center justify-center rounded-lg text-foreground/50 hover:bg-foreground/5 hover:text-accent-blue transition-colors outline-none mb-0.5 ml-0.5" title={language === "Khmer" ? "បញ្ចូលរូបភាព" : "Upload chart or image"}>
                    <ImagePlus size={18} />
                 </button>
                 <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleFileUpload} />
                 
                  <textarea
                    value={inputMessage}
                    onChange={(e) => {
                      setInputMessage(e.target.value);
                      e.target.style.height = 'auto';
                      e.target.style.height = Math.min(e.target.scrollHeight, 128) + 'px';
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSendMessage();
                        e.currentTarget.style.height = 'auto';
                      }
                    }}
                    placeholder={language === 'Khmer' ? "សួរអំពីស្ថិរភាពបណ្តាញវដ្ត ឬបញ្ចូលរូបភាពសម្រាប់ការវិភាគ..." : "Ask about grid stability, cycle calculations, or upload a chart for analysis..."}
                    className="flex-1 bg-transparent border-0 px-3 py-2.5 text-[13px] leading-relaxed focus:outline-none focus:ring-0 resize-none scrollbar-thin self-end min-h-[40px] max-h-32 mb-0 block"
                    rows={1}
                  />
                  <button 
                    onClick={handleSendMessage}
                    disabled={(!inputMessage.trim() && !attachment) || isLoading}
                    className="shrink-0 self-end h-[36px] w-[36px] flex items-center justify-center rounded-lg text-accent-blue hover:bg-accent-blue hover:text-white disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-accent-blue transition-colors group mb-0.5 mr-0.5"
                  >
                    <Send size={16} className="group-hover:scale-110 transition-transform" />
                  </button>
              </div>
           </div>
        </div>
      </div>
      
      {/* Right Analysis Result Panel */}
      <div className="flex-1 flex flex-col bg-panel relative min-w-0 hidden lg:flex">
         <div className="px-4 h-14 flex items-center justify-between border-b border-border-v bg-surface/50 shrink-0">
             <div className="font-bold text-[11px] uppercase tracking-wider flex items-center gap-2">
                 Analysis Output
             </div>
             {lastValidMessage && (
                 <button
                    onClick={() => {
                        navigator.clipboard.writeText(lastValidMessage.content);
                        setCopiedIndex(-1);
                        setTimeout(() => setCopiedIndex(null), 2000);
                    }}
                    className={cn("text-[10px] uppercase font-bold tracking-widest transition-colors flex items-center gap-1 px-3 py-1.5 rounded-sm border", copiedIndex === -1 ? "text-green-500 bg-green-500/10 border-green-500/20" : "text-foreground/80 hover:text-foreground hover:bg-foreground/5 border-foreground/20")}
                 >
                    {copiedIndex === -1 ? <><Check size={14} /> Copied Result</> : <><Copy size={14} /> Copy Result</>}
                 </button>
             )}
         </div>
         <div className="flex-1 overflow-y-auto p-6 md:p-8 bg-background/30">
             {lastValidMessage ? (
                 <div className="markdown-body max-w-3xl mx-auto">
                     <Markdown>{lastValidMessage.content}</Markdown>
                 </div>
             ) : (
                 <div className="h-full flex items-center justify-center text-foreground/30 text-[12px] uppercase tracking-widest font-mono">
                     {language === 'Khmer' ? 'មិនទាន់មានលទ្ធផលវិភាគនៅឡើយទេ' : 'No analysis output generated yet.'}
                 </div>
             )}
         </div>
      </div>
    </section>
  );
}
