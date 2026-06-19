(function () {
  "use strict";
  const config = window.STRIKE_RUSH_CONFIG;
  const rt = new window.StrikeRushRealtime("player");
  const $ = (selector) => document.querySelector(selector);
  const views = [...document.querySelectorAll(".phone-view")];
  const avatars = [
    ["🎳", "#FF2E63", "Boule vintage"], ["🔮", "#08D9D6", "Boule néon"],
    ["⚡", "#F6C90E", "Éclair"], ["👾", "#8A2BE2", "Quille rebelle"],
    ["🔥", "#FF6B35", "Fireball"], ["🦈", "#00A8CC", "Requin"],
    ["👑", "#FFD166", "Kingpin"], ["🛸", "#7B61FF", "Cosmic"]
  ];
  const chats = ["Strike !", "Oh non...", "Il est chaud", "Bluffeur"];
  let state = null;
  let profile = null;
  let selectedAvatar = 0;
  let selectedPrediction = "";
  let powerBetActive = false;
  let lastResolvedFrame = 0;
  let timerInterval = 0;

  const show = (id) => views.forEach((view) => view.classList.toggle("active", view.id === id));
  const toast = (message) => {
    $("#toast").textContent = message;
    $("#toast").classList.add("show");
    setTimeout(() => $("#toast").classList.remove("show"), 2200);
  };
  const vibrate = (pattern) => navigator.vibrate?.(pattern);

  document.querySelectorAll("[data-app-name]").forEach((el) => el.textContent = config.appName.toUpperCase());
  document.documentElement.style.setProperty("--pink", config.colors.pink);
  document.documentElement.style.setProperty("--cyan", config.colors.cyan);
  document.documentElement.style.setProperty("--violet", config.colors.violet);
  $("#creditsValue").textContent = config.game.startingCredits;
  $("#stakeRange").max = config.game.maxBet;

  $("#avatarGrid").innerHTML = avatars.map(([icon,, label], index) => `<button type="button" data-avatar="${index}" aria-label="${label}" title="${label}">${icon}</button>`).join("");
  $("#avatarGrid button").firstElementChild?.classList.add("selected");
  $("#avatarGrid").addEventListener("click", ({ target }) => {
    const button = target.closest("[data-avatar]");
    if (!button) return;
    selectedAvatar = Number(button.dataset.avatar);
    document.querySelectorAll("[data-avatar]").forEach((el) => el.classList.toggle("selected", el === button));
  });

  function makeChat(target) {
    $(target).innerHTML = chats.map((message) => `<button data-chat="${message}">${message}</button>`).join("");
    $(target).addEventListener("click", ({ target: element }) => {
      const button = element.closest("[data-chat]");
      if (button) rt.sendChat(button.dataset.chat);
    });
  }
  makeChat("#waitingChat");
  makeChat("#gameChat");

  function player() { return state?.players?.[rt.clientId]; }
  function predictionLabel(value) { return ({ "0": "0", "1-9": "1–9", spare: "／", strike: "×" })[value] || value; }

  function updateTimer() {
    clearInterval(timerInterval);
    const tick = () => {
      const seconds = Math.max(0, Math.ceil(((state?.bettingEndsAt || 0) - Date.now()) / 1000));
      $("#mobileTimer").textContent = seconds;
      if (seconds === 0 && state?.phase === "betting" && !state.bets[rt.clientId]) show("waitingView");
    };
    tick();
    timerInterval = setInterval(tick, 250);
  }

  function renderResult(me, bet) {
    if (!bet || lastResolvedFrame === state.frame) return;
    lastResolvedFrame = state.frame;
    const won = Boolean(bet.won);
    $("#resultIcon").textContent = won ? "✓" : "×";
    $("#resultIcon").classList.toggle("miss", !won);
    $("#resultEyebrow").textContent = won ? "BIEN VU" : "PAS CETTE FOIS";
    $("#resultHeading").innerHTML = won ? "PRÉDICTION<br>PARFAITE." : "LA PISTE T’A<br>SURPRIS.";
    $("#rewardValue").textContent = won ? `+${bet.reward}` : `-${bet.stake}`;
    $("#streakValue").textContent = won ? `STREAK ${me.streak}` : "STREAK RÉINITIALISÉE";
    if (won) vibrate([60,40,120]);
    show("resultView");
  }

  function render(next) {
    state = next;
    const me = player();
    if (!me) return;
    $("#creditsValue").textContent = me.credits;
    $("#mobileFrame").textContent = Math.max(1, state.frame);
    $("#mobileBowler").textContent = state.bowler.toUpperCase();
    $("#playerName").textContent = me.nickname;
    $("#playerAvatar").textContent = me.avatar;
    $("#powerBet").classList.toggle("locked", me.streak < 3);
    $("#powerBetToggle").disabled = me.streak < 3;
    $("#powerTarget").disabled = me.streak < 3;
    $("#powerTarget").innerHTML = Object.values(state.players).map((candidate) => `<option value="${candidate.nickname}">${candidate.nickname}</option>`).join("");
    const bet = state.bets?.[rt.clientId];

    if (state.phase === "lobby" || state.phase === "waiting") show("waitingView");
    if (state.phase === "betting") {
      if (bet) {
        $("#lockedPrediction").textContent = predictionLabel(bet.prediction);
        $("#lockedStake").textContent = bet.stake;
        show("lockedView");
      } else {
        selectedPrediction = "";
        powerBetActive = false;
        $("#powerBetToggle").classList.remove("active");
        document.querySelectorAll("[data-prediction]").forEach((el) => el.classList.remove("selected"));
        $("#confirmBetButton").disabled = true;
        show("betView");
        vibrate([80,60,80]);
        updateTimer();
      }
    }
    if (state.phase === "result") renderResult(me, bet);
    if (state.phase === "finished") {
      if (state.lastResult && lastResolvedFrame !== state.frame) renderResult(me, bet);
      setTimeout(() => renderFinal(me), 1500);
    }
  }

  function renderFinal(me) {
    const accuracy = me.bets ? Math.round((me.correct / me.bets) * 100) : 0;
    $("#personalSummary").innerHTML = `
      <div><span>CRÉDITS FINAUX</span><b>${me.credits}</b></div>
      <div><span>MEILLEURE STREAK</span><b>${me.bestStreak}</b></div>
      <div><span>PRÉCISION</span><b>${accuracy}%</b></div>
      <div><span>GAINS BRUTS</span><b>${me.totalWon}</b></div>`;
    localStorage.setItem("strike-rush-last-stats", JSON.stringify({ credits: me.credits, bestStreak: me.bestStreak, accuracy, totalWon: me.totalWon, at: Date.now() }));
    loadStats();
    show("finalView");
  }

  $("#joinForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const room = $("#roomInput").value.trim().toUpperCase();
    const nickname = $("#nicknameInput").value.trim().toUpperCase();
    if (!/^[A-ZÀ-ÖØ-Ý0-9_-]{3,12}$/i.test(nickname)) return $("#joinError").textContent = "Pseudo : 3 à 12 caractères, lettres et chiffres.";
    if (!/^[A-Z0-9]{6}$/.test(room)) return $("#joinError").textContent = "Le code doit contenir 6 caractères.";
    profile = { nickname, avatar: avatars[selectedAvatar][0], color: avatars[selectedAvatar][1] };
    $("#joinError").textContent = "";
    rt.joinRoom(room, profile);
  });

  rt.on("joined", ({ room }) => {
    state = room;
    show("waitingView");
    render(room);
  }).on("state", render).on("error-message", (message) => {
    $("#joinError").textContent = message;
    toast(message);
  });

  $("#predictionGrid").addEventListener("click", ({ target }) => {
    const button = target.closest("[data-prediction]");
    if (!button) return;
    selectedPrediction = button.dataset.prediction;
    document.querySelectorAll("[data-prediction]").forEach((el) => el.classList.toggle("selected", el === button));
    $("#confirmBetButton").disabled = false;
  });
  $("#stakeRange").addEventListener("input", ({ target }) => $("#stakeOutput").textContent = target.value);
  $("#confirmBetButton").addEventListener("click", () => {
    if (!selectedPrediction) return;
    rt.placeBet(selectedPrediction, $("#stakeRange").value, powerBetActive, $("#powerTarget").value);
  });
  $("#powerBetToggle").addEventListener("click", () => {
    if ($("#powerBetToggle").disabled) return;
    powerBetActive = !powerBetActive;
    $("#powerBetToggle").classList.toggle("active", powerBetActive);
  });
  $("#continueButton").addEventListener("click", () => show(state?.phase === "finished" ? "finalView" : "waitingView"));
  document.querySelectorAll("[data-dialog]").forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.dialog}`).showModal()));
  document.querySelectorAll(".dialog-close").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));

  function loadStats() {
    const stats = JSON.parse(localStorage.getItem("strike-rush-last-stats") || "null");
    $("#savedStats").innerHTML = stats ? `
      <div><b>${stats.credits}</b><span>CRÉDITS</span></div>
      <div><b>${stats.bestStreak}</b><span>MEILLEURE STREAK</span></div>
      <div><b>${stats.accuracy}%</b><span>PRÉCISION</span></div>
      <div><b>${stats.totalWon}</b><span>GAINS</span></div>` : "<p>Aucune partie terminée sur ce téléphone.</p>";
  }

  const roomFromUrl = new URLSearchParams(location.search).get("room");
  if (roomFromUrl) $("#roomInput").value = roomFromUrl.toUpperCase();
  loadStats();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
})();
