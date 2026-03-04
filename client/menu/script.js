document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('username');
  const createBtn = document.getElementById('createBtn');
  const joinBtn = document.getElementById('joinBtn');

  function updateButtons(){
    const ok = input.value.trim().length > 0;
    createBtn.disabled = !ok;
    joinBtn.disabled = !ok;
  }

  input.addEventListener('input', updateButtons);
  updateButtons();

  createBtn.addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name) return;
    try {
      const res = await fetch('/create-lobby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      if (!res.ok) throw new Error('Create failed');
      const data = await res.json();
      // save name so game page can set it automatically
      sessionStorage.setItem('playerName', name);
      // redirect to the generated lobby URL
      window.location.href = data.url;
    } catch (err) {
      alert('Failed to create lobby');
      console.error(err);
    }
  });

  joinBtn.addEventListener('click', () => {
    const name = input.value.trim();
    if (!name) return;
    const lobbyId = prompt('Enter lobby id to join:');
    if (!lobbyId) return;
    sessionStorage.setItem('playerName', name);
    window.location.href = `/lobby?lobby=${encodeURIComponent(lobbyId)}`;
  });
});
(function(){
			const input = document.getElementById('username');
			const createBtn = document.getElementById('createBtn');
			const joinBtn = document.getElementById('joinBtn');

			function updateButtons(){
				const ok = input.value.trim().length > 0;
				createBtn.disabled = !ok;
				joinBtn.disabled = !ok;
			}

			input.addEventListener('input', updateButtons);

			// Optional: handle clicks (placeholder behavior)
			createBtn.addEventListener('click', ()=>{
				const name = input.value.trim();
				if(!name) return;
				// Replace with real create-lobby logic
				alert('Create lobby as "' + name + '"');
			});

			joinBtn.addEventListener('click', ()=>{
				const name = input.value.trim();
				if(!name) return;
				// Replace with real join-lobby logic
				alert('Join lobby as "' + name + '"');
			});

			// Focus input on load
			input.focus();
			updateButtons();
		})();

function createLobby(){

}