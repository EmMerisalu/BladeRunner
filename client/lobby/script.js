 (function(){
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${location.host}${location.search}`);
      const playersEl = document.getElementById('players');
      const readyBtn = document.getElementById('readyBtn');
      const startBtn = document.getElementById('startBtn');
      const lobbyIdEl = document.getElementById('lobbyId');
      const copyBtn = document.getElementById('copyId');
      const status = document.getElementById('status');

      let myId = null;
      let isHost = false;
      let currentPlayers = [];

      // show lobby id from query
      try {
        const params = new URLSearchParams(location.search);
        const lid = params.get('lobby') || '-';
        lobbyIdEl.textContent = lid;
      } catch (e) { lobbyIdEl.textContent = '-'; }

      copyBtn.addEventListener('click', () => {
        navigator.clipboard?.writeText(lobbyIdEl.textContent || '')
          .then(()=> status.textContent = 'Copied')
          .catch(()=> status.textContent = 'Copy failed');
      });

      ws.onopen = () => {
        status.textContent = 'Connected';
        const stored = sessionStorage.getItem('playerName');
        if (stored) {
          try {
            ws.send(JSON.stringify({ type: 'setName', name: stored }));
            readyBtn.disabled = false;
          } catch (e) {
            console.error('Failed to send name on open', e);
          }
        } else {
          status.textContent = 'No player name found — please return to menu';
          readyBtn.disabled = true;
        }
      };

      ws.onclose = () => { status.textContent = 'Disconnected'; };

      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'rejected') {
          status.textContent = msg.reason || 'Rejected';
          return;
        }

        if (msg.type === 'welcome') {
          myId = msg.id;
          isHost = !!msg.isHost;
          if (isHost) startBtn.style.display = 'inline';
        }

        if (msg.type === 'lobby') {
          currentPlayers = msg.players || [];
          renderPlayers(currentPlayers, msg.hostId);
          // host logic
          if (myId === msg.hostId) {
            startBtn.style.display = 'inline';
            const allReady = currentPlayers.length >= 1 && currentPlayers.every(p => p.ready && p.name);
            startBtn.disabled = !allReady;
          } else {
            startBtn.style.display = 'none';
          }
        }

        if (msg.type === 'nameTaken') {
          status.textContent = 'Name already taken';
        }

        if (msg.type === 'start') {
          // redirect to game for this lobby
          const params = new URLSearchParams(location.search);
          const lid = params.get('lobby');
          if (lid) window.location.href = '/game?lobby=' + encodeURIComponent(lid);
        }
      };

      function renderPlayers(list, hostId){
        playersEl.innerHTML = list.map(p => `
          <div class="player">${p.name || '(unnamed)'} ${p.id===hostId? '👑':''} ${p.ready? '✅':''}</div>
        `).join('');
      }

      // name is set on the menu; no UI here to change it

      readyBtn.addEventListener('click', () => {
        ws.send(JSON.stringify({ type: 'ready' }));
      });

      startBtn.addEventListener('click', () => {
        ws.send(JSON.stringify({ type: 'startGame' }));
      });
    })();