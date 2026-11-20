const time = document.querySelector('#focus-time');
const toggle = document.querySelector('#focus-toggle');
const reset = document.querySelector('#focus-reset');
const fullTime = Number(time.dataset.minutes) * 60 * 1000;
const remainingKey = 'focus-remaining-' + time.dataset.userId + '-' + time.dataset.minutes;
const endKey = 'focus-end-' + time.dataset.userId + '-' + time.dataset.minutes;
let remaining = Number(sessionStorage.getItem(remainingKey) ?? fullTime);
let endsAt = Number(sessionStorage.getItem(endKey) ?? 0);

function save() {
  sessionStorage.setItem(remainingKey, remaining);
  sessionStorage.setItem(endKey, endsAt);
}

function render() {
  if (endsAt) {
    remaining = Math.max(0, endsAt - Date.now());
    if (!remaining) {
      endsAt = 0;
      save();
    }
  }
  const seconds = Math.ceil(remaining / 1000);
  time.textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  toggle.textContent = endsAt ? 'Ⅱ' : '▶';
  toggle.setAttribute('aria-label', endsAt ? 'Приостановить таймер' : 'Начать фокус');
}

toggle.addEventListener('click', () => {
  if (endsAt) {
    remaining = Math.max(0, endsAt - Date.now());
    endsAt = 0;
  } else {
    if (!remaining) remaining = fullTime;
    endsAt = Date.now() + remaining;
  }
  save();
  render();
});

reset.addEventListener('click', () => {
  endsAt = 0;
  remaining = fullTime;
  save();
  render();
});

render();
setInterval(render, 250);
