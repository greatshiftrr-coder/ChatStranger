import express from 'express';
import { createServer as createViteServer } from 'vite';
import { Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;
  
  const httpServer = createServer(app);
  
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: "*",
    }
  });

  // ChatStranger Matchmaking Logic
  let waitingUsers: string[] = []; // Queue of socket IDs waiting for a match
  const activeMatches = new Map<string, string>(); // Map of socket.id -> partner's socket.id

  io.on('connection', (socket) => {
    // console.log(`User connected: ${socket.id}`);
    
    // User requests to find a stranger
    socket.on('find_stranger', () => {
      // If already matched, disconnect from current first
      const currentPartner = activeMatches.get(socket.id);
      if (currentPartner) {
        socket.to(currentPartner).emit('stranger_disconnected');
        activeMatches.delete(currentPartner);
        activeMatches.delete(socket.id);
      }
      
      // If user is already in waiting list, don't add again
      if (!waitingUsers.includes(socket.id)) {
        waitingUsers.push(socket.id);
      }
      
      // Check for a match
      if (waitingUsers.length >= 2) {
        // We have at least 2 users waiting, match the first two
        const user1 = waitingUsers.shift()!;
        const user2 = waitingUsers.shift()!;
        
        // Ensure both sockets are still connected before matching
        const s1 = io.sockets.sockets.get(user1);
        const s2 = io.sockets.sockets.get(user2);
        
        if (s1 && s2) {
          activeMatches.set(user1, user2);
          activeMatches.set(user2, user1);
          
          s1.emit('matched');
          s2.emit('matched');
        } else {
          // If one disconnected during wait, put the other back in queue
          if (s1) waitingUsers.push(user1);
          if (s2) waitingUsers.push(user2);
        }
      }
    });

    socket.on('public_key', (key) => {
      const partnerId = activeMatches.get(socket.id);
      if (partnerId) {
        socket.to(partnerId).emit('stranger_public_key', key);
      }
    });

    socket.on('send_message', (messagePackage) => {
      const partnerId = activeMatches.get(socket.id);
      if (partnerId) {
        socket.to(partnerId).emit('receive_message', messagePackage);
      }
    });

    socket.on('typing', () => {
      const partnerId = activeMatches.get(socket.id);
      if (partnerId) {
        socket.to(partnerId).emit('typing');
      }
    });

    socket.on('stop_typing', () => {
      const partnerId = activeMatches.get(socket.id);
      if (partnerId) {
        socket.to(partnerId).emit('stop_typing');
      }
    });

    socket.on('leave', () => {
      // Manually drop from queue or active match
      waitingUsers = waitingUsers.filter(id => id !== socket.id);
      
      const partnerId = activeMatches.get(socket.id);
      if (partnerId) {
        socket.to(partnerId).emit('stranger_disconnected');
        activeMatches.delete(partnerId);
        activeMatches.delete(socket.id);
      }
    });

    socket.on('disconnect', () => {
      // console.log(`User disconnected: ${socket.id}`);
      waitingUsers = waitingUsers.filter(id => id !== socket.id);
      
      const partnerId = activeMatches.get(socket.id);
      if (partnerId) {
        socket.to(partnerId).emit('stranger_disconnected');
        activeMatches.delete(partnerId);
        activeMatches.delete(socket.id);
      }
    });
  });

  // API routes
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Vite middleware for development
  let vite;
  if (process.env.NODE_ENV !== 'production') {
    vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
