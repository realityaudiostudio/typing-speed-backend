const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config(); 

const app = express();
app.use(cors());

const server = http.createServer(app);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

let globalTexts = ["The quick brown fox jumps over the lazy dog."]; 

async function refreshTexts() {
  const { data, error } = await supabase.from('typing_texts').select('content');
  if (data && data.length > 0) {
    globalTexts = data.map(row => row.content);
    console.log(`📚 Texts Reloaded! Loaded ${globalTexts.length} paragraphs.`);
  }
}
refreshTexts();

// --- GAME STATE ---
let queue = []; 
let liveMatches = {}; // Stores both WAITING and IN_PROGRESS matches
let activeMatches = 0; 

io.on('connection', (socket) => {
  
  // --- ADMIN COMMANDS ---
  socket.on('admin_refresh_texts', () => refreshTexts());
  
  socket.on('admin_subscribe', () => {
    socket.emit('live_matches_list', liveMatches);
  });

  // NEW: Admin starts a specific match
  socket.on('admin_start_match', (roomId) => {
    const match = liveMatches[roomId];
    if (match && match.status === 'WAITING') {
        match.status = 'IN_PROGRESS';
        match.startTime = Date.now();
        
        // Notify players to START
        io.to(roomId).emit('match_found', { 
          roomId, 
          opponentName: match.p2.name, // Logic handled in Arena to swap names
          text: match.text, 
          p1: match.p1.name, 
          p2: match.p2.name
        });
        
        // Update Admin
        io.emit('live_matches_list', liveMatches);
        console.log(`🚀 Match Started by Admin: ${roomId}`);
    }
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
        console.log(`⚡ Match Created (Waiting for Admin): ${roomId}`);

        const randomText = globalTexts[Math.floor(Math.random() * globalTexts.length)];

        // 1. Create Match State (Set Status to WAITING)
        liveMatches[roomId] = {
            roomId,
            status: 'WAITING', // <--- NEW STATUS
            startTime: null,
            text: randomText,
            p1: { id: p1.socketId, name: p1.name, wpm: 0, progress: 0, input: "" },
            p2: { id: p2.socketId, name: p2.name, wpm: 0, progress: 0, input: "" }
        };

        // 2. Notify Players to WAIT
        io.to(roomId).emit('waiting_for_admin', {
            roomId,
            p1: p1.name,
            p2: p2.name
        });

        // 3. Notify Admin (New match appears in list)
        io.emit('live_matches_list', liveMatches);
      }
    }
  });

  // --- TYPING UPDATES ---
  // --- TYPING UPDATES ---
  socket.on('type_update', (data) => {
    const match = liveMatches[data.roomId];
    if (match && match.status === 'IN_PROGRESS') { 
        if (socket.id === match.p1.id) {
            // Updated to include accuracy
            match.p1 = { ...match.p1, wpm: data.wpm, progress: data.progress, input: data.input, accuracy: data.accuracy };
        } else if (socket.id === match.p2.id) {
            // Updated to include accuracy
            match.p2 = { ...match.p2, wpm: data.wpm, progress: data.progress, input: data.input, accuracy: data.accuracy };
        }
        // Broadcast accuracy to opponent too
        socket.to(data.roomId).emit('opponent_update', { 
            progress: data.progress, 
            wpm: data.wpm, 
            accuracy: data.accuracy 
        });
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