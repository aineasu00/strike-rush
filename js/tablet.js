(function () {
  "use strict";
  const config = window.STRIKE_RUSH_CONFIG;
  const rt = new window.StrikeRushRealtime("host");
  let state = null;
  let timerInterval = 0;
  const $ = (selector) => document.querySelector(selector);
  const screens = [...document.querySelectorAll(".screen")];
  const show = (id) => screens.forEach((screen) => screen.classList.toggle("active", screen.id === id));
  const toast = (message) => {
    $("#toast").textContent = message;
    $("#toast").classList.add("show");
    setTimeout(() => $("#toast").classList.remove("show"), 2200);
  };

  document.querySelectorAll("[data-app-name]").forEach((el) => el.textContent = config.appName.toUpperCase());
  document.querySelectorAll("[data-bowling-name]").forEach((el) => el.textContent = config.bowlingName.toUpperCase());
  document.documentElement.style.setProperty("--pink", config.colors.pink);
  document.documentElement.style.setProperty("--cyan", config.colors.cyan);
  document.documentElement.style.setProperty("--violet", config.colors.violet);

  function buildJoinUrl(code) {
    const url = new URL("./player.html", location.href);
    url.searchParams.set("room", code);
    return url.href;
  }

  function renderQr(url) {
    // API statique sans clé. Le lien texte reste disponible si le service est indisponible.
    $("#qrImage").src = `https://api.qrserver.com/v1/create-qr-code/?size=420x420&margin=12&data=${encodeURIComponent(url)}`;
    $("#qrImage").onerror = () => {
      $("#qrImage").src = "./assets/icon.svg";
      toast("QR indisponible : utilisez le lien affiché.");
    };
  }

  async function setupRoom() {
    const code = await rt.createRoom();
    if (!code) return;
    $("#roomCode").textContent = code;
    const url = buildJoinUrl(code);
    $("#joinUrl").href = url;
    $("#joinUrl").textContent = url;
    renderQr(url);
  }

  function renderPlayers() {
    const players = Object.values(state?.players || {}).sort((a, b) => b.credits - a.credits);
    $("#playerCount").textContent = players.length;
    $("#playerBubbles").innerHTML = players.map((p) => `<span title="${escapeHtml(p.nickname)}">${p.avatar}</span>`).join("");
    $("#leaderboardList").innerHTML = players.length ? players.map((p) => `
      <li><span>${p.avatar}</span><div><b>${escapeHtml(p.nickname)}</b><small>${p.streak ? `STREAK ×${p.streak}` : "EN COURSE"}</small></div><b>${p.credits}</b></li>
    `).join("") : '<li class="empty-state">Les joueurs apparaîtront ici.</li>';
    const currentBowler = $("#bowlerSelect").value;
    $("#bowlerSelect").innerHTML = '<option value="Joueur libre">Joueur libre</option>' + players.map((p) => `<option value="${escapeHtml(p.nickname)}">${escapeHtml(p.nickname)}</option>`).join("");
    if ([...$("#bowlerSelect").options].some((option) => option.value === currentBowler)) $("#bowlerSelect").value = currentBowler;
  }

  function renderDistribution() {
    const bets = Object.values(state?.bets || {});
    const counts = { "0": 0, "1-9": 0, spare: 0, strike: 0 };
    bets.forEach((bet) => counts[bet.prediction]++);
    const max = Math.max(1, ...Object.values(counts));
    [...$("#betDistribution").children].forEach((bar, index) => {
      const key = ["0", "1-9", "spare", "strike"][index];
      bar.style.setProperty("--value", `${12 + (counts[key] / max) * 82}%`);
    });
    $("#betStatus").textContent = state?.phase === "betting" ? `${bets.length} mise${bets.length > 1 ? "s" : ""} verrouillée${bets.length > 1 ? "s" : ""}` : "En attente de la nouvelle frame";
  }

  function renderChat() {
    const chats = state?.chats || [];
    $("#chatFeed").innerHTML = chats.length ? [...chats].reverse().map((chat) => `<span><b>${escapeHtml(chat.nickname)}</b> · ${escapeHtml(chat.message)}</span>`).join("") : "<span>Le chat rapide s’affichera ici.</span>";
  }

  function renderPodium() {
    const top = Object.values(state.players).sort((a, b) => b.credits - a.credits).slice(0, 3);
    $("#podium").innerHTML = top.map((p, index) => `<div class="podium-place"><span class="avatar">${p.avatar}</span><b>${escapeHtml(p.nickname)}</b><small>${p.credits} CRÉDITS</small><div class="podium-block">${index + 1}</div></div>`).join("");
  }

  function render(next) {
    state = next;
    renderPlayers();
    renderDistribution();
    renderChat();
    $("#frameNumber").textContent = Math.max(1, state.frame);
    $("#nextBowler").textContent = state.bowler.toUpperCase();
    const maxStreak = Math.max(0, ...Object.values(state.players).map((p) => p.streak));
    const hype = Math.min(100, 18 + Object.keys(state.bets).length * 7 + maxStreak * 15);
    $("#hypeBar").style.width = `${hype}%`;
    $("#hypeValue").textContent = `${hype}%`;
    if (state.phase === "lobby") show("lobbyScreen");
    else if (state.phase === "finished") { renderPodium(); show("podiumScreen"); }
    else show("gameScreen");
    $("#roundTitle").textContent = state.phase === "betting" ? "LES MISES SONT OUVERTES" : state.phase === "result" ? "RÉSULTAT VALIDÉ" : "PRÊTS À MISER ?";
    if (state.lastResult?.type === "strike" || state.lastResult?.pins === 10) {
      $("#strikeFlash").classList.remove("show");
      requestAnimationFrame(() => $("#strikeFlash").classList.add("show"));
    }
    startTimer();
  }

  function startTimer() {
    clearInterval(timerInterval);
    const tick = () => {
      const seconds = state?.phase === "betting" ? Math.max(0, Math.ceil((state.bettingEndsAt - Date.now()) / 1000)) : config.game.bettingSeconds;
      $("#timer span").textContent = seconds;
      $("#timer").classList.toggle("urgent", seconds <= 5 && state?.phase === "betting");
      if (seconds === 0 && state?.phase === "betting") $("#roundTitle").textContent = "MISES VERROUILLÉES";
    };
    tick();
    timerInterval = setInterval(tick, 250);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
  }

  rt.on("state", render)
    .on("error-message", toast)
    .on("connection", ({ online, mode }) => {
      $("#connectionStatus").textContent = mode === "local" ? "MODE DÉMO" : online ? "TEMPS RÉEL CONNECTÉ" : "HORS LIGNE";
      $("#connectionStatus").classList.toggle("online", online);
    });

  $("#startGameButton").addEventListener("click", () => {
    if (!state || !Object.keys(state.players).length) return toast("Ajoutez au moins un joueur.");
    rt.hostAction("start");
  });
  $("#newFrameButton").addEventListener("click", () => {
    if (state?.frame >= config.game.totalFrames) return toast("Les 10 frames sont terminées.");
    rt.hostAction("open-betting", { bowler: $("#bowlerSelect").value });
  });
  $("#submitResultButton").addEventListener("click", () => {
    if (state?.phase !== "betting") return toast("Ouvrez d’abord une nouvelle frame.");
    rt.hostAction("result", { pins: $("#pinsInput").value, type: $("#resultType").value });
  });
  $("#resultType").addEventListener("change", ({ target }) => {
    if (target.value === "strike") $("#pinsInput").value = 10;
  });
  $("#newLobbyButton").addEventListener("click", async () => {
    await rt.hostAction("new-lobby");
    show("lobbyScreen");
    await setupRoom();
  });
  $("#fullscreenButton").addEventListener("click", () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
  $("#soundToggle").addEventListener("click", ({ currentTarget }) => {
    currentTarget.classList.toggle("online");
    toast(currentTarget.classList.contains("online") ? "Sons activés" : "Sons coupés");
  });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
  setupRoom();
})();
