# BladeRunner Web Game

Node.js + WebSocket game server with both multiplayer and single-player (NPC) gameplay.

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

The server hosts all client pages and handles game state for human and virtual players.

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

# Single-Player Mode (NPC Opponents)

From the main menu, choose **Single Player (offline lobby with NPCs)** to create an offline-only lobby where only the lead player can connect.

In single-player mode:

- Additional incoming player connections are refused by the server.
- You can configure **1 to 3 virtual opponents** (2-4 total players in a match).
- Each opponent can be configured with a difficulty only:
  - `easy`
  - `medium`
  - `hard`
- Bot names are generated automatically (and can be re-rolled in the menu).
- The menu shows a pre-game **effectiveness score** (`0-100`) per bot.
- Difficulty acts as a multiplier, so a high-skill bot in `hard` mode is significantly stronger.

NPC behavior is server-authoritative and intentionally imperfect:

- Easy bots can miss obvious plays and fail to execute plans.
- Medium bots are generally reliable and competitive.
- Hard bots react quickly and execute plans with high consistency.
- Bots also compete against each other, not only against the human player.

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

`POST /create-lobby` also accepts optional single-player settings in the request body:

```json
{
  "singlePlayer": true,
  "botCount": 3,
  "bots": [
    {
      "name": "Steel Runner",
      "difficulty": "easy"
    }
  ]
}
```

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