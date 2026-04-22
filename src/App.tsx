import { useEffect, useState, useRef, type FormEvent, type ChangeEvent } from 'react';
import { io, Socket } from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';
import { cn } from './lib/utils';
import { Send, Users, Loader2, LogOut, ArrowRight, X, MessageSquare, ShieldAlert, Lock, Camera, User, Image as ImageIcon } from 'lucide-react';
import { generateKeyPair, exportPublicKey, importPublicKey, deriveSharedKey, encryptMessage, decryptMessage } from './lib/crypto';
import { motion, AnimatePresence } from 'motion/react';

type AppState = 'landing' | 'waiting' | 'chatting';

type UserProfile = {
  name: string;
  avatar: string | null; // Base64 data URL
};

type Message = {
  id: string;
  sender: 'you' | 'stranger' | 'system';
  text: string;
  image?: string;
  timestamp: Date;
  reactions?: Record<string, string[]>;
};

const EMOJIS = ['👍', '❤️', '😂', '😮', '😢'];

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [appState, setAppState] = useState<AppState>('landing');
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isStrangerTyping, setIsStrangerTyping] = useState(false);
  const [isEncryptionReady, setIsEncryptionReady] = useState(false);
  
  const [profile, setProfile] = useState<UserProfile>(() => {
    const saved = localStorage.getItem('chatstranger_profile');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        // ignore
      }
    }
    return { name: 'Anonymous', avatar: null };
  });
  
  const [strangerProfile, setStrangerProfile] = useState<UserProfile>({ name: 'Stranger', avatar: null });
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Encryption keys
  const privateKeyRef = useRef<CryptoKey | null>(null);
  const publicKeyRef = useRef<CryptoKey | null>(null);
  const sharedKeyRef = useRef<CryptoKey | null>(null);

  const prepareNewSession = async () => {
    setAppState('waiting');
    setMessages([]);
    setIsStrangerTyping(false);
    setIsEncryptionReady(false);
    setStrangerProfile({ name: 'Stranger', avatar: null });
    sharedKeyRef.current = null;
    
    try {
      const keyPair = await generateKeyPair();
      privateKeyRef.current = keyPair.privateKey;
      publicKeyRef.current = keyPair.publicKey;
    } catch (e) {
      console.error("Failed to generate keypair:", e);
    }
  };

  // Save profile to localStorage
  useEffect(() => {
    localStorage.setItem('chatstranger_profile', JSON.stringify(profile));
  }, [profile]);

  // Once connection is secure and chatting, send our profile
  useEffect(() => {
    if (isEncryptionReady && appState === 'chatting' && sharedKeyRef.current && socket) {
      const sendInitialProfile = async () => {
        try {
          const payload = JSON.stringify({ type: 'profile', profile });
          const encryptedPayload = await encryptMessage(payload, sharedKeyRef.current!);
          socket.emit('send_message', encryptedPayload);
        } catch (e) {
           console.error("Failed to encrypt and send profile", e);
        }
      };
      sendInitialProfile();
    }
  }, [isEncryptionReady, appState, profile, socket]);

  // Auto-scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStrangerTyping]);

  useEffect(() => {
    // Determine the socket.io URL. In production, it's the same origin.
    // In dev, the Vite proxy handles it, but since we are running via tsx server.ts,
    // the server is on the same host/port.
    const newSocket = io({
      autoConnect: true,
    });

    setSocket(newSocket);

    newSocket.on('connect', () => {
      console.log('Connected to server');
    });

    newSocket.on('matched', async () => {
      setAppState('chatting');
      setMessages([{
        id: uuidv4(),
        sender: 'system',
        text: 'You are now chatting with a random stranger. Establishing secure connection...',
        timestamp: new Date()
      }]);
      
      if (publicKeyRef.current) {
        try {
          const jwk = await exportPublicKey(publicKeyRef.current);
          newSocket.emit('public_key', jwk);
        } catch (e) {
          console.error("Failed to export public key", e);
        }
      }
    });

    newSocket.on('stranger_public_key', async (jwk: JsonWebKey) => {
      if (privateKeyRef.current) {
        try {
          const strangerKey = await importPublicKey(jwk);
          const derived = await deriveSharedKey(privateKeyRef.current, strangerKey);
          sharedKeyRef.current = derived;
          setIsEncryptionReady(true);
          setMessages(prev => [...prev, {
            id: uuidv4(),
            sender: 'system',
            text: '🔒 End-to-end encryption established. Your messages are secure.',
            timestamp: new Date()
          }]);
        } catch (e) {
          console.error("Failed to establish E2EE", e);
        }
      }
    });

    newSocket.on('receive_message', async (encryptedData: { iv: number[], ciphertext: number[] }) => {
      setIsStrangerTyping(false);
      if (sharedKeyRef.current) {
        try {
          const decryptedText = await decryptMessage(encryptedData, sharedKeyRef.current);
          
          try {
            const parsed = JSON.parse(decryptedText);
            if (parsed.type === 'chat') {
              setMessages(prev => [...prev, {
                id: parsed.id || uuidv4(),
                sender: 'stranger',
                text: parsed.text || '',
                image: parsed.image,
                timestamp: new Date()
              }]);
            } else if (parsed.type === 'profile') {
              setStrangerProfile(parsed.profile);
            } else if (parsed.type === 'reaction') {
              setMessages(prev => prev.map(m => {
                if (m.id === parsed.messageId) {
                  const currentReactions = m.reactions || {};
                  const voters = currentReactions[parsed.emoji] || [];
                  const isReacted = voters.includes('stranger');
                  
                  const newVoters = isReacted ? voters.filter(v => v !== 'stranger') : [...voters, 'stranger'];
                  const newReactions = { ...currentReactions, [parsed.emoji]: newVoters };
                  if (newVoters.length === 0) {
                    delete newReactions[parsed.emoji];
                  }
                  
                  return { ...m, reactions: newReactions };
                }
                return m;
              }));
            }
          } catch(e) {
            // fallback
            setMessages(prev => [...prev, {
              id: uuidv4(),
              sender: 'stranger',
              text: decryptedText,
              timestamp: new Date()
            }]);
          }

        } catch (e) {
          console.error("Failed to decrypt message", e);
        }
      } else {
        console.warn("Received message but encryption key is not ready");
      }
    });

    newSocket.on('typing', () => {
      setIsStrangerTyping(true);
    });

    newSocket.on('stop_typing', () => {
      setIsStrangerTyping(false);
    });

    newSocket.on('stranger_disconnected', () => {
      setMessages(prev => [...prev, {
        id: uuidv4(),
        sender: 'system',
        text: 'Stranger has disconnected.',
        timestamp: new Date()
      }]);
      setAppState('landing');
      setIsStrangerTyping(false);
    });

    return () => {
      newSocket.disconnect();
    };
  }, []);

  const startChatting = async () => {
    if (!socket) return;
    await prepareNewSession();
    socket.emit('find_stranger');
  };

  const skipStranger = async () => {
    if (!socket) return;
    socket.emit('leave');
    await prepareNewSession();
    socket.emit('find_stranger');
  };

  const leaveChat = () => {
    if (!socket) return;
    socket.emit('leave');
    setAppState('landing');
    setMessages([]);
    setIsStrangerTyping(false);
    setIsEncryptionReady(false);
    sharedKeyRef.current = null;
  };

  const handleReact = async (messageId: string, emoji: string) => {
    setMessages(prev => prev.map(m => {
      if (m.id === messageId) {
        const currentReactions = m.reactions || {};
        const voters = currentReactions[emoji] || [];
        const isReacted = voters.includes('you');
        
        const newVoters = isReacted ? voters.filter(v => v !== 'you') : [...voters, 'you'];
        const newReactions = { ...currentReactions, [emoji]: newVoters };
        if (newVoters.length === 0) {
          delete newReactions[emoji];
        }
        return { ...m, reactions: newReactions };
      }
      return m;
    }));

    if (sharedKeyRef.current && socket) {
      try {
        const payload = JSON.stringify({ type: 'reaction', messageId, emoji });
        const encryptedPayload = await encryptMessage(payload, sharedKeyRef.current);
        socket.emit('send_message', encryptedPayload);
      } catch (e) {
        console.error("Failed to send reaction", e);
      }
    }
  };

  const sendChatMessage = async (text: string, imageBase64?: string) => {
    if (!socket || appState !== 'chatting' || !sharedKeyRef.current) return;
    if (!text && !imageBase64) return;

    const newMsg: Message = {
      id: uuidv4(),
      sender: 'you',
      text: text,
      image: imageBase64,
      timestamp: new Date()
    };

    setInputValue('');
    socket.emit('stop_typing');
    setMessages(prev => [...prev, newMsg]);

    try {
      const payload = JSON.stringify({ type: 'chat', id: newMsg.id, text, image: imageBase64 });
      const encryptedPayload = await encryptMessage(payload, sharedKeyRef.current);
      socket.emit('send_message', encryptedPayload);
    } catch (e) {
      console.error("Failed to encrypt message", e);
    }
  };

  const handleSendMessage = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!inputValue.trim() && !appState) return; // Prevent empty sends if just texts
    sendChatMessage(inputValue.trim());
  };

  const processAndSendImage = (file: File) => {
    if (!file.type.startsWith('image/')) {
      alert("Please upload an image file.");
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 800;
        const MAX_HEIGHT = 800;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; }
        } else {
          if (height > MAX_HEIGHT) { width *= MAX_HEIGHT / height; height = MAX_HEIGHT; }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          const base64Data = canvas.toDataURL('image/jpeg', 0.8);
          sendChatMessage(inputValue.trim(), base64Data);
        }
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const handleImageUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert("Please upload an image file.");
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 150;
        const MAX_HEIGHT = 150;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          const base64Data = canvas.toDataURL('image/jpeg', 0.8);
          setProfile(prev => ({ ...prev, avatar: base64Data }));
        }
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const handleTyping = (e: ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
    
    if (appState !== 'chatting' || !socket) return;

    socket.emit('typing');
    
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    
    typingTimeoutRef.current = setTimeout(() => {
      socket.emit('stop_typing');
    }, 1500);
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col font-sans text-slate-200">
      {/* Header */}
      <header className="bg-slate-900 border-b border-slate-800 p-4 sticky top-0 z-10 shrink-0">
        <div className="max-w-4xl mx-auto flex justify-between items-center h-10">
          {appState === 'chatting' ? (
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-slate-800 border-2 border-slate-700 overflow-hidden flex items-center justify-center shrink-0">
                {strangerProfile.avatar ? (
                  <img src={strangerProfile.avatar} alt="Stranger" className="w-full h-full object-cover" />
                ) : (
                  <User className="w-5 h-5 text-slate-500" />
                )}
              </div>
              <div className="flex flex-col">
                <span className="font-semibold text-white leading-tight">
                  {strangerProfile.name || 'Stranger'}
                </span>
                {isEncryptionReady ? (
                  <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-400 tracking-wider">
                    <Lock className="w-2.5 h-2.5" /> SECURE
                  </span>
                ) : (
                  <span className="text-[10px] font-bold text-slate-500 tracking-wider">CONNECTING...</span>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <MessageSquare className="w-6 h-6 text-indigo-500" />
              <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-3">
                ChatStranger
              </h1>
            </div>
          )}
          
          {appState === 'chatting' && (
            <div className="flex items-center gap-2 sm:gap-3">
              <button 
                onClick={skipStranger}
                className="text-sm px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors flex items-center gap-2"
              >
                <ArrowRight className="w-4 h-4" />
                <span className="hidden sm:inline">Skip</span>
              </button>
              <button 
                onClick={leaveChat}
                className="text-sm px-3 py-1.5 rounded-md bg-red-950/40 hover:bg-red-900/60 text-red-400 border border-red-900/20 transition-colors flex items-center gap-2"
              >
                <LogOut className="w-4 h-4" />
                <span className="hidden sm:inline">Leave</span>
              </button>
            </div>
          )}
          {appState === 'waiting' && (
            <button 
              onClick={leaveChat}
              className="text-sm px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors flex items-center gap-2"
            >
              <X className="w-4 h-4" />
              <span>Cancel</span>
            </button>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col max-w-4xl w-full mx-auto p-4 transition-all space-y-4">
        
        {appState === 'landing' && (
          <div className="flex-1 flex flex-col items-center justify-center text-center max-w-lg mx-auto py-12">
            <h2 className="text-4xl font-bold text-white mb-4 tracking-tight">Talk to Strangers</h2>
            <p className="text-slate-400 mb-8 text-lg">
              Meet new people in a 1-on-1 anonymous chat room. No login, no tracking, just conversation.
            </p>

            <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl mb-8 w-full shadow-lg">
              <h3 className="text-xl font-bold mb-4 text-white">Your Profile</h3>
              <div className="flex items-center gap-4">
                <div className="relative">
                  <div className="w-16 h-16 rounded-full bg-slate-800 overflow-hidden border-2 border-slate-700 flex items-center justify-center">
                    {profile.avatar ? (
                      <img src={profile.avatar} alt="Avatar" className="w-full h-full object-cover" />
                    ) : (
                      <User className="w-8 h-8 text-slate-500" />
                    )}
                  </div>
                  <label className="absolute bottom-0 right-0 bg-indigo-600 rounded-full p-1.5 cursor-pointer hover:bg-indigo-500 transition-colors shadow-lg">
                    <Camera className="w-3 h-3 text-white" />
                    <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
                  </label>
                </div>
                <div className="flex-1 text-left">
                  <label className="block text-xs font-semibold text-slate-400 mb-1 uppercase tracking-wider">Nickname</label>
                  <input 
                    type="text" 
                    value={profile.name} 
                    onChange={(e) => setProfile({...profile, name: e.target.value})} 
                    className="w-full bg-slate-950 border border-slate-800 focus:border-indigo-500 rounded-lg px-3 py-2 text-white placeholder:text-slate-600 outline-none transition-all" 
                    placeholder="Anonymous" 
                  />
                </div>
              </div>
            </div>
            
            <button
              onClick={startChatting}
              className="px-8 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-full font-medium text-lg transition-all transform hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-indigo-500/20"
            >
              Start Chatting
            </button>
            
            <div className="mt-12 p-4 bg-slate-900/50 rounded-xl border border-slate-800 flex items-start gap-3 text-left">
              <ShieldAlert className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              <p className="text-sm text-slate-400">
                <strong className="text-slate-300 font-medium">Safety Note:</strong> You are talking to real strangers. Keep personal info safe and be respectful.
              </p>
            </div>
          </div>
        )}

        {appState === 'waiting' && (
          <div className="flex-1 flex flex-col items-center justify-center text-center">
             <Loader2 className="w-12 h-12 text-indigo-500 animate-spin mb-6" />
             <h2 className="text-2xl font-semibold text-white mb-2">Looking for a stranger...</h2>
             <p className="text-slate-400">Please wait while we connect you with someone.</p>
          </div>
        )}

        {/* Chat Area */}
        {appState === 'chatting' && (
          <div className="flex-[1_1_0] flex flex-col min-h-0 relative">
            <div className="flex-1 overflow-y-auto w-full custom-scrollbar space-y-3 pb-4">
              {messages.map((msg, index) => {
                const isYou = msg.sender === 'you';
                const isSystem = msg.sender === 'system';
                
                if (isSystem) {
                  return (
                    <div key={msg.id} className="flex justify-center my-4">
                      <span className="bg-slate-800/80 text-slate-400 text-xs px-3 py-1 rounded-full font-medium text-center">
                        {msg.text}
                      </span>
                    </div>
                  );
                }

                const senderName = isYou ? profile.name || 'You' : strangerProfile.name || 'Stranger';
                const senderAvatar = isYou ? profile.avatar : strangerProfile.avatar;
                
                const showProfile = !isYou && (index === 0 || messages[index-1]?.sender !== 'stranger');

                return (
                  <div key={msg.id} className={cn("flex w-full gap-2 group", isYou ? "justify-end" : "justify-start")}>
                    {!isYou && showProfile && (
                      <div className="w-8 h-8 rounded-full bg-slate-800 shrink-0 overflow-hidden flex items-center justify-center border border-slate-700 mt-1">
                        {senderAvatar ? (
                          <img src={senderAvatar} alt={senderName} className="w-full h-full object-cover" />
                        ) : (
                          <User className="w-4 h-4 text-slate-500" />
                        )}
                      </div>
                    )}
                    {!isYou && !showProfile && <div className="w-8 shrink-0"></div>}
                    
                    <div className={cn(
                      "max-w-[75%] rounded-2xl px-4 py-2 break-words relative",
                      isYou 
                        ? "bg-indigo-600 text-white rounded-br-sm" 
                        : "bg-slate-800 text-slate-200 rounded-bl-sm",
                      (msg.reactions && Object.keys(msg.reactions).length > 0) && "mb-3"
                    )}>
                      {/* Reaction Menu */}
                      <div className={cn(
                        "absolute -top-10 flex items-center gap-1 bg-slate-800 border border-slate-700 rounded-full px-2 py-1.5 shadow-xl opacity-0 transition-all z-20 scale-95 origin-bottom pointer-events-none",
                        isYou ? "right-0" : "left-0",
                        "group-hover:opacity-100 group-hover:scale-100 group-hover:pointer-events-auto"
                      )}>
                         {EMOJIS.map(emoji => (
                             <button key={emoji} onClick={() => handleReact(msg.id, emoji)} className="hover:scale-125 transition-transform px-1 cursor-pointer text-base" title="React">
                               {emoji}
                             </button>
                         ))}
                      </div>

                      {!isYou && showProfile && (
                         <div className="text-[10px] uppercase font-bold tracking-wider text-slate-400 mb-1">{senderName}</div>
                      )}
                      
                      {msg.image && (
                        <div className={cn("overflow-hidden rounded-lg border border-slate-700/50 mb-1", msg.text ? "mb-2" : "")}>
                          <img src={msg.image} alt="Chat attachment" className="w-full max-w-[240px] sm:max-w-[320px] h-auto object-cover" />
                        </div>
                      )}
                      
                      {msg.text && (
                        <div className="whitespace-pre-wrap leading-relaxed">{msg.text}</div>
                      )}

                      {/* Render active reactions */}
                      {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                        <div className={cn(
                          "absolute -bottom-3 flex gap-1 z-10 flex-wrap",
                           isYou ? "right-2 flex-row-reverse" : "left-2"
                        )}>
                          <AnimatePresence>
                            {(Object.entries(msg.reactions) as [string, string[]][]).map(([emoji, voters]) => (
                              <motion.button 
                                key={emoji} 
                                layout
                                initial={{ scale: 0 }}
                                animate={{ scale: 1 }}
                                exit={{ scale: 0 }}
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                transition={{ type: "spring", stiffness: 500, damping: 25 }}
                                onClick={() => handleReact(msg.id, emoji)} 
                                className={cn(
                                  "text-xs bg-slate-900 border border-slate-700 rounded-full px-1.5 py-0.5 flex items-center shadow-sm", 
                                  voters.includes('you') && "border-indigo-500 bg-indigo-900/40"
                                )}
                              >
                                 <motion.span 
                                   key={`${msg.id}-${emoji}-${voters.length}`}
                                   initial={{ y: 5, opacity: 0 }}
                                   animate={{ y: 0, opacity: 1 }}
                                   transition={{ type: "spring", stiffness: 300, damping: 20 }}
                                 >
                                   {emoji}
                                 </motion.span>
                                 <AnimatePresence mode="popLayout" initial={false}>
                                   {voters.length > 1 && (
                                     <motion.span 
                                       key={voters.length}
                                       initial={{ y: -5, opacity: 0, scale: 0.5 }}
                                       animate={{ y: 0, opacity: 1, scale: 1 }}
                                       exit={{ y: 5, opacity: 0, scale: 0.5 }}
                                       transition={{ type: "spring", stiffness: 300, damping: 20 }}
                                       className="ml-1 text-[10px] text-slate-300 font-medium inline-block relative -top-[0.5px]"
                                     >
                                       {voters.length}
                                     </motion.span>
                                   )}
                                 </AnimatePresence>
                              </motion.button>
                            ))}
                          </AnimatePresence>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              
              {isStrangerTyping && (
                <div className="flex w-full justify-start gap-2">
                  <div className="w-8 h-8 rounded-full bg-slate-800 shrink-0 overflow-hidden flex items-center justify-center border border-slate-700 mt-1">
                    {strangerProfile.avatar ? (
                      <img src={strangerProfile.avatar} alt="Stranger" className="w-full h-full object-cover" />
                    ) : (
                      <User className="w-4 h-4 text-slate-500" />
                    )}
                  </div>
                  <div className="bg-slate-800 text-slate-400 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce [animation-delay:-0.3s]"></span>
                    <span className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce [animation-delay:-0.15s]"></span>
                    <span className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce"></span>
                  </div>
                </div>
              )}
              
              <div ref={messagesEndRef} />
            </div>

            {/* Input Form */}
            <form onSubmit={handleSendMessage} className="mt-2 relative flex gap-2">
              <div className="relative flex-1">
                {isEncryptionReady && (
                  <div className="absolute left-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    <label className="p-2 cursor-pointer hover:bg-slate-800 rounded-full transition-colors text-slate-400 hover:text-indigo-400 group/btn">
                      <ImageIcon className="w-5 h-5" />
                      <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                        if(e.target.files?.[0]) processAndSendImage(e.target.files[0]);
                        e.target.value = '';
                      }} />
                    </label>
                    <label className="p-2 cursor-pointer hover:bg-slate-800 rounded-full transition-colors text-slate-400 hover:text-indigo-400 group/btn">
                      <Camera className="w-5 h-5" />
                      <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => {
                        if(e.target.files?.[0]) processAndSendImage(e.target.files[0]);
                        e.target.value = '';
                      }} />
                    </label>
                  </div>
                )}
                <input
                  type="text"
                  value={inputValue}
                  onChange={handleTyping}
                  placeholder={isEncryptionReady ? "Type a message..." : "Establishing secure link..."}
                  disabled={!isEncryptionReady}
                  className={cn(
                    "w-full bg-slate-900 border border-slate-700 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-full pr-12 py-3.5 text-white placeholder:text-slate-500 outline-none transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed",
                    isEncryptionReady ? "pl-[96px]" : "pl-5"
                  )}
                  autoFocus
                  autoComplete="off"
                />
                {!isEncryptionReady && (
                  <div className="absolute right-4 top-1/2 -translate-y-1/2">
                    <Loader2 className="w-4 h-4 text-slate-500 animate-spin" />
                  </div>
                )}
              </div>
              <button
                type="submit"
                disabled={!inputValue.trim() || !isEncryptionReady}
                className="aspect-square w-12 shrink-0 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white rounded-full flex items-center justify-center transition-colors"
                aria-label="Send message"
              >
                <Send className="w-5 h-5 ml-0.5" />
              </button>
            </form>
          </div>
        )}
      </main>
      
      {/* Footer */}
      {(appState === 'landing' || appState === 'waiting') && (
        <footer className="py-6 text-center text-slate-500 text-xs">
          Built with React & Socket.IO
        </footer>
      )}
    </div>
  );
}
