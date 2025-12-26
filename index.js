const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config(); // Load .env

const app = express();
app.use(cors());

const server = http.createServer(app);

// --- SUPABASE SETUP ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- TEXT CACHE SYSTEM ---
let globalTexts = ["The quick brown fox jumps over the lazy dog."]; // Fallback

async function refreshTexts() {
  const { data, error } = await supabase.from('typing_texts').select('content');
  if (data && data.length > 0) {
    globalTexts = data.map(row => row.content);
    console.log(`📚 Texts Reloaded! Loaded ${globalTexts.length} paragraphs.`);
  }
}

// Load texts immediately on start
refreshTexts();

// --- GAME STATE ---
let queue = []; 
let liveMatches = {}; 
let activeMatches = 0; 

io.on('connection', (socket) => {
  
  // --- ADMIN: RELOAD TEXTS ---
  // When Admin adds a text, they send this signal to update the server instantly
  socket.on('admin_refresh_texts', () => {
    refreshTexts();
  });

  // --- ADMIN: LIVE DATA ---
  socket.on('admin_subscribe', () => {
    socket.emit('live_matches_list', liveMatches);
  });

  // --- MATCHMAKING ---
  socket.on('join_queue', (userData) => {
    queue.push({ socketId: socket.id, ...userData });
    
    if (queue.length >= 2) {
      const p1 = queue.shift();
      const p2 = queue.shift();
      const roomId = `room_${p1.socketId}_${p2.socketId}`;

      const p1Socket = io.sockets.sockets.get(p1.socketId);
      const p2Socket = io.sockets.sockets.get(p2.socketId);

      if (p1Socket && p2Socket) {
        p1Socket.join(roomId);
        p2Socket.join(roomId);
        
        activeMatches++;
        console.log(`⚡ MATCH STARTED! Room: ${roomId}`);

        // SELECT RANDOM TEXT FROM DATABASE CACHE
        const randomText = globalTexts[Math.floor(Math.random() * globalTexts.length)];

        // Create Live State
        liveMatches[roomId] = {
            roomId,
            startTime: Date.now(),
            text: randomText,
            p1: { id: p1.socketId, name: p1.name, wpm: 0, progress: 0, input: "" },
            p2: { id: p2.socketId, name: p2.name, wpm: 0, progress: 0, input: "" }
        };

        // Notify Players
        io.to(roomId).emit('match_found', { 
          roomId, 
          opponentName: p2.name, 
          text: randomText, 
          p1: p1.name, p2: p2.name
        });

        io.emit('live_matches_list', liveMatches);
      }
    }
  });

  // --- TYPING UPDATES ---
  socket.on('type_update', (data) => {
    const match = liveMatches[data.roomId];
    if (match) {
        if (socket.id === match.p1.id) {
            match.p1 = { ...match.p1, wpm: data.wpm, progress: data.progress, input: data.input };
        } else if (socket.id === match.p2.id) {
            match.p2 = { ...match.p2, wpm: data.wpm, progress: data.progress, input: data.input };
        }
        socket.to(data.roomId).emit('opponent_update', { progress: data.progress, wpm: data.wpm });
        io.to(data.roomId).emit('spectator_update', match);
    }
  });

  socket.on('join_spectator', (roomId) => socket.join(roomId));

  socket.on('game_finish', (data) => {
     const match = liveMatches[data.roomId];
     if(match) {
         delete liveMatches[data.roomId];
         socket.to(data.roomId).emit('game_over', { winner: false });
         if (activeMatches > 0) activeMatches--;
         io.emit('live_matches_list', liveMatches);
     }
  });

  socket.on('disconnect', () => {
    queue = queue.filter(user => user.socketId !== socket.id);
  });
});

const PORT = 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});