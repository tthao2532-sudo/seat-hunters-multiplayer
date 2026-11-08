'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.json({ ok: true }));
const rooms = new Map();
const LOBBY_GRACE_MS = 30 * 60 * 1000; // Keep disconnected lobby players for 30 minutes
const stations = ['Taipei Main Station','NTU Hospital','Chiang Kai-shek Memorial Hall','Dongmen','Daan Park'];
const names = ['Mei','Jun','Lin','Chen','Wei','Yu','An','Kai','Xin','Bo'];
const randomId = () => crypto.randomBytes(12).toString('hex');
const makeCode = () => { let c; do { c = String(crypto.randomInt(100000, 1000000)); } while (rooms.has(c)); return c; };
const sanitize = s => String(s || '').trim().replace(/[<>]/g, '').slice(0, 20);
const emitError = (socket, message) => socket.emit('gameError', message);
const roundInfo = room => ({ number: room.round + 1, station: stations[room.round], passengers: room.passengers, vacated: room.phase === 'predict' ? [] : room.vacated, phase: room.phase, phaseEnd: room.phaseEnd, predictions: room.predictions.size, seats: room.seats, lucky: room.lucky, last: room.last });
function publicState(room) {
  return { code: room.code, status: room.status, host: room.host, players: [...room.players.values()].map(p => ({ id:p.id, name:p.name, score:p.score, connected:p.connected })), round: room.status === 'playing' ? roundInfo(room) : null, result: room.result || null, serverTime: Date.now() };
}
function broadcast(room) { io.to(room.code).emit('state', publicState(room)); }
function clearTimers(room) { for (const t of room.timers) clearTimeout(t); room.timers = []; }
function schedule(room, fn, ms) { room.timers.push(setTimeout(() => { if (rooms.get(room.code) === room) fn(); }, ms)); }
function startRound(room, index) {
  if (index >= 5) return finish(room);
  room.round = index; room.phase = 'predict'; room.phaseEnd = Date.now() + 5000;
  room.passengers = names.map((name,i) => ({ id:i, name }));
  room.vacated = [...Array(10).keys()].sort(() => Math.random() - .5).slice(0, 3);
  room.predictions = new Map(); room.seats = []; room.lucky = null; room.last = null;
  broadcast(room);
  schedule(room, () => reveal(room), 5000);
}
function reveal(room) {
  if (room.status !== 'playing') return;
  const correct = [...room.predictions.entries()].filter(([,p]) => room.vacated.includes(p.seat)).sort((a,b) => a[1].at - b[1].at || a[1].seq - b[1].seq);
  for (const [id] of correct) { const p=room.players.get(id); if(p) p.score += 10; }
  const winner = correct[0]?.[0] || null;
  if (winner && room.players.has(winner)) { room.players.get(winner).score += 20; room.lucky = winner; }
  room.phase = 'reveal'; room.phaseEnd = Date.now() + 2000;
  // The Lucky Seat MUST be the exact seat predicted by the earliest correct player.
  // Do not use vacated[0]: the departing seats are in random order.
  const luckyPos = winner ? room.predictions.get(winner).seat : null;
  room.seats = room.vacated.map(pos => ({
    pos,
    type: pos === luckyPos ? 'lucky' : 'free',
    owner: pos === luckyPos ? winner : null
  }));
  // If no correct guess, all 3 seats become free.
  room.last = { correct: correct.map(([id]) => id), lucky: winner };
  broadcast(room);
  schedule(room, () => rush(room), 2000);
}
function rush(room) {
  if (room.status !== 'playing') return;
  room.phase = 'rush'; room.phaseEnd = Date.now() + 4000; broadcast(room);
  schedule(room, () => results(room), 4000);
}
function results(room) {
  if (room.status !== 'playing') return;
  room.phase = 'results'; room.phaseEnd = Date.now() + 1000; broadcast(room);
  schedule(room, () => startRound(room, room.round + 1), 1000);
}
function finish(room) {
  room.status = 'finished'; room.phase = 'finished'; room.finishedAt = Date.now();
  room.result = [...room.players.values()].map(p=>({id:p.id,name:p.name,score:p.score})).sort((a,b)=>b.score-a.score);
  broadcast(room);
}
function getPlayerRoom(socket) {
  const code = socket.data.roomCode; const id = socket.data.playerId;
  const room = rooms.get(code); const player = room?.players.get(id);
  if (!room || !player || !player.connected || player.socketId !== socket.id) return null;
  return {room, player};
}
function join(socket, code, name, token, reply) {
  const room = rooms.get(code);
  if (!room) return reply({ok:false,error:'Room not found. Check the code.'});
  if (room.status === 'finished') return reply({ok:false,error:'This game has finished. Ask the host to create a new room.'});
  let player = token && [...room.players.values()].find(p=>p.token === token);
  if (!player) {
    if (room.status !== 'lobby') return reply({ok:false,error:'Game already started. You can only reconnect.'});
    if (room.players.size >= 40) return reply({ok:false,error:'Room is full (40 players).'});
    const clean = sanitize(name);
    if (!clean) return reply({ok:false,error:'Please enter your name.'});
    const id = randomId(); player = { id, token:randomId(), name:clean, score:0, connected:false, socketId:null, disconnectedAt:null }; room.players.set(id,player);
  }
  if (player.socketId) { const old=io.sockets.sockets.get(player.socketId); if(old && old.id!==socket.id) old.disconnect(true); }
  player.socketId=socket.id; player.connected=true; player.disconnectedAt=null; room.lastActiveAt=Date.now(); socket.join(code); socket.data.roomCode=code; socket.data.playerId=player.id;
  if (!room.host || !room.players.has(room.host)) room.host=player.id;
  else if (!room.players.get(room.host).connected && room.host!==player.id) room.host=player.id;
  reply({ok:true,code,id:player.id,token:player.token}); broadcast(room);
}
io.on('connection', socket => {
  socket.on('createRoom', (name, reply) => {
    if (typeof reply !== 'function') return;
    const clean=sanitize(name); if (!clean) return reply({ok:false,error:'Enter your name first.'});
    const code=makeCode(); rooms.set(code,{code,host:null,status:'lobby',players:new Map(),timers:[],round:-1,phase:'lobby',predictions:new Map(),seats:[],result:null,lastActiveAt:Date.now()});
    join(socket,code,clean,null,reply);
  });
  socket.on('joinRoom', ({code,name,token} = {}, reply) => {
    if (typeof reply !== 'function') return;
    join(socket,String(code||'').trim(),name,token,reply);
  });
  socket.on('startGame', () => {
    const x=getPlayerRoom(socket); if(!x) return;
    const {room,player}=x;
    if (room.host!==player.id || room.status!=='lobby') return emitError(socket,'Only the host can start the game.');
    if ([...room.players.values()].filter(p=>p.connected).length < 2) return emitError(socket,'At least 2 connected players are required.');
    room.status='playing'; room.players.forEach(p=>p.score=0); startRound(room,0);
  });
  socket.on('predict', (pos) => {
    const x=getPlayerRoom(socket); if(!x) return;
    const {room,player}=x;
    if(room.status!=='playing'||room.phase!=='predict'||Date.now()>room.phaseEnd) return;
    if(!Number.isInteger(pos)||pos<0||pos>9||room.predictions.has(player.id)) return;
    room.predictions.set(player.id,{seat:pos,at:Date.now(),seq:room.predictions.size}); broadcast(room);
  });
  socket.on('claim', (pos) => {
    const x=getPlayerRoom(socket); if(!x) return;
    const {room,player}=x;
    if(room.status!=='playing'||room.phase!=='rush'||Date.now()>room.phaseEnd) return;
    if(room.seats.some(s=>s.owner===player.id)) return;
    const seat=room.seats.find(s=>s.pos===pos&&s.type==='free'&&!s.owner);
    if(!seat) return;
    seat.owner=player.id; player.score+=20; broadcast(room);
  });
  socket.on('disconnect', () => {
    const code=socket.data.roomCode, id=socket.data.playerId, room=rooms.get(code), player=room?.players.get(id);
    if(!room||!player||player.socketId!==socket.id) return;
    player.connected=false; player.socketId=null; player.disconnectedAt=Date.now();
    room.lastActiveAt=Date.now();
    // Do not delete the player or the lobby on a temporary disconnection.
    // Their saved token lets them return to the same room.
    if(room.status!=='lobby' && room.host===id) room.host=[...room.players.values()].find(p=>p.connected)?.id||null;
    broadcast(room);
  });
});
// Expire abandoned rooms to prevent unbounded memory use.
setInterval(()=>{
  const now=Date.now();
  for(const [code,room] of rooms){
    if(room.status==='lobby'){
      // Remove players who have been offline for over 30 minutes.
      for(const [id,p] of room.players){
        if(!p.connected && p.disconnectedAt && now-p.disconnectedAt>=LOBBY_GRACE_MS) room.players.delete(id);
      }
      if(!room.players.has(room.host)) room.host=[...room.players.values()].find(p=>p.connected)?.id||[...room.players.keys()][0]||null;
      // Only expire an abandoned lobby after its 30-minute grace period.
      if(![...room.players.values()].some(p=>p.connected) && now-(room.lastActiveAt||now)>=LOBBY_GRACE_MS){
        clearTimers(room);rooms.delete(code);continue;
      }
      broadcast(room);
    }
    if(room.status==='finished' && room.finishedAt && now-room.finishedAt>3600000){clearTimers(room);rooms.delete(code);}
  }
},60000).unref();
const PORT=process.env.PORT||3000;
server.listen(PORT,'0.0.0.0',()=>console.log(`Seat Hunters listening on ${PORT}`));
