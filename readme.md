# Multiplayer Game Server

Node.js + WebSocket server for the multiplayer game lobby and gameplay.

---

# Requirements

Before running the server, install:

- **Node.js 18+** (recommended)
- **npm** (comes with Node)

Check your installation:

```bash
node -v
npm -v
```

---

# Project Structure

Example layout:

```
project-root/
│
├ server/
│   ├ server.js
│   └ package.json
│
└ client/
    ├ menu/
    ├ lobby/
    └ game/
```

The server hosts the client files and handles WebSocket multiplayer connections.

---

# Setup (from the `server` directory)

Navigate to the server folder:

```bash
cd server
```

Initialize npm (only required once):

```bash
npm init -y
```

Install required dependencies:

```bash
npm install express ws
```

This installs:

- **express** – serves the client files and API endpoints  
- **ws** – WebSocket server used for multiplayer communication  

---

# Running the Server

Start the server with:

```bash
node server.js
```

If successful you should see:

```
Server running on http://localhost:3000
```

---

# Opening the Game

Open a browser and go to:

```
http://localhost:3000
```

Then:

1. Create a lobby  
2. Share the lobby link with other players  
3. All players join and press **Ready**  
4. Host presses **Start Game**

---

# Creating a Lobby (API)

The server creates lobbies through:

```
POST /create-lobby
```

Example response:

```json
{
  "lobbyId": "abc123",
  "url": "/lobby?lobby=abc123"
}
```

Players must join using the lobby URL.

---

# WebSocket Connection

Clients connect using:

```
ws://localhost:3000/?lobby=LOBBY_ID
```

Example:

```
ws://localhost:3000/?lobby=abc123
```

If the lobby does not exist or is full, the server will reject the connection.