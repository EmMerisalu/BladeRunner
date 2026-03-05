document.addEventListener('DOMContentLoaded', () => {

const input = document.getElementById('username');
const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');

function updateButtons() {
  const ok = input.value.trim().length > 0;
  createBtn.disabled = !ok;
  joinBtn.disabled = !ok;
}

input.addEventListener('input', updateButtons);
updateButtons();

const saved = sessionStorage.getItem('playerName');
if (saved) {
  input.value = saved;
  updateButtons();
}

createBtn.addEventListener('click', async () => {

  const name = input.value.trim();
  if (!name) return;

  try {

    const res = await fetch('/create-lobby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });

    const data = await res.json();

    sessionStorage.setItem('playerName', name);

    window.location.href = data.url;

  } catch (err) {

    console.error(err);
    alert('Failed to create lobby');

  }

});

joinBtn.addEventListener('click', () => {

  const name = input.value.trim();
  if (!name) return;

  const lobbyId = prompt('Enter lobby ID');

  if (!lobbyId) return;

  sessionStorage.setItem('playerName', name);

  window.location.href = `/game/?lobby=${encodeURIComponent(lobbyId)}`;

});

});