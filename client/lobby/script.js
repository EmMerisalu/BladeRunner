(function(){

const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${protocol}//${location.host}${location.search}`);

const playersEl = document.getElementById('players');
const readyBtn = document.getElementById('readyBtn');
const startBtn = document.getElementById('startBtn');
const lobbyIdEl = document.getElementById('lobbyId');
const copyBtn = document.getElementById('copyId');
const status = document.getElementById('status');
const nameInput = document.getElementById('nameInput');

let myId = null;
let currentPlayers = [];

const params = new URLSearchParams(location.search);
const lobbyId = params.get('lobby');
lobbyIdEl.textContent = lobbyId || "-";

copyBtn.onclick = () => {
navigator.clipboard.writeText(lobbyId);
status.textContent = "Lobby ID copied";
};

ws.onopen = () => {
  status.textContent = "Connected";
  const saved = sessionStorage.getItem('playerName');
  if (saved) {
    nameInput.value = saved;
    ws.send(JSON.stringify({ type: "setName", name: saved }));
    readyBtn.disabled = false;
  }
};

ws.onclose = () => {
status.textContent = "Disconnected";
};

ws.onmessage = (ev) => {

const msg = JSON.parse(ev.data);

if(msg.type === "welcome"){
myId = msg.id;
if(msg.isHost){
startBtn.style.display = "inline";
}
}

if(msg.type === "lobby"){

currentPlayers = msg.players;

renderPlayers(msg.players,msg.hostId);

if(myId === msg.hostId){
const allReady =
msg.players.length >= 1 &&
msg.players.every(p => p.ready && p.name);

startBtn.disabled = !allReady;
}
}

if(msg.type === "nameTaken"){
status.textContent = "Name already taken";
}

if(msg.type === "start"){
window.location.href = "/game?lobby=" + lobbyId;
}

};

nameInput.addEventListener("change",()=>{
const name = nameInput.value.trim();

if(name.length > 0){
ws.send(JSON.stringify({
type:"setName",
name
}));

sessionStorage.setItem("playerName",name);

readyBtn.disabled = false;
}
});

readyBtn.onclick = ()=>{
ws.send(JSON.stringify({type:"ready"}));
};

startBtn.onclick = ()=>{
ws.send(JSON.stringify({type:"startGame"}));
};

function renderPlayers(players,hostId){

playersEl.innerHTML = players.map(p=>{

const readyIcon = p.ready ? "🟢" : "⚪";
const crown = p.id === hostId ? "👑" : "";

return `
<div class="player">
<span class="status">${readyIcon}</span>
<span class="name">${p.name || "(unnamed)"}</span>
<span class="host">${crown}</span>
</div>
`;

}).join("");

}

})();