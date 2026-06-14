/**
 * Rasaec's QOL — v2.0.0
 *
 * Feature 1: Auto-clear targets when a token you own ends its turn in combat.
 *
 * Feature 2: PF2e/SF2e Damage Tray
 *   Appends a per-target row to every damage roll chat card with five buttons:
 *     ½  — half damage  (basic save success / resistance)
 *     ×1 — full damage  (normal hit)
 *     ×2 — double damage (critical hit)
 *     🛡  — shield block toggle (reduces damage by shield hardness)
 *     ♥  — apply as healing instead
 *
 *   All damage is applied through the PF2e system's own pipeline, so typed
 *   damage, IWR (immunities / weaknesses / resistances), and all system
 *   automation work exactly as they do with the standard buttons.
 *
 * Architecture note
 *   The PF2e system's existing damage buttons work by reading canvas.tokens.controlled
 *   (the currently selected tokens) when clicked. Our tray exploits this: for each
 *   button click we (1) save the current selection, (2) select only the target token,
 *   (3) dispatch a synthetic MouseEvent on the matching system button, then (4) restore
 *   the original selection. This routes 100% through the system's typed-damage pipeline
 *   with zero reimplementation.
 *
 *   For non-GM clients whose targets are owned enemies (rare in PF2e but possible),
 *   we send a socket message so the GM client can perform the selection+click on their
 *   authoritative canvas.
 */

const MODULE_ID  = "rasaecs-qol";
const SOCK       = `module.${MODULE_ID}`;

// ─── Per-message shield-block state (client-local Map<messageId, Set<tokenUuid>>) ──
const shieldActive = new Map();

// ============================================================
// Utilities
// ============================================================

/** Resolve a TokenDocument → Token (placeable) from a UUID, safely. */
function tokenFromUuid(uuid) {
  try {
    const doc = fromUuidSync(uuid);
    return doc?.object ?? doc?._object ?? null;
  } catch {
    return null;
  }
}

/** Resolve Actor from a token UUID. */
function actorFromUuid(uuid) {
  try {
    const doc = fromUuidSync(uuid);
    return doc?.actor ?? null;
  } catch {
    return null;
  }
}

function hpString(actor) {
  const hp = actor?.system?.attributes?.hp;
  if (!hp) return "? / ?";
  const sp = actor?.system?.attributes?.sp;
  if (sp) {
    return `HP ${hp.value}/${hp.max}  SP ${sp.value}/${sp.max}`;
  }
  return `${hp.value} / ${hp.max}`;
}

function isPf2eDamageRoll(message) {
  if (!message.rolls?.length) return false;
  const roll = message.rolls[0];
  if (roll?.constructor?.name === "DamageRoll") return true;
  if (message.flags?.pf2e?.context?.type === "damage-roll") return true;
  if (message.flags?.pf2e?.damageRoll) return true;
  return false;
}

function isSpellCardWithSave(message) {
  const pf2e = message.flags?.pf2e;
  if (!pf2e) return false;
  if (isPf2eDamageRoll(message)) return false;
  const contextType = pf2e.context?.type ?? "";
  const EXCLUDED = ["saving-throw", "skill-check", "attack-roll", "perception-check"];
  if (EXCLUDED.includes(contextType)) return false;
  const ALLOWED = ["spell-cast", "spell-attack", ""];
  if (!ALLOWED.includes(contextType)) return false;
  const rollOptions = pf2e.origin?.rollOptions ?? pf2e.context?.options ?? [];
  const hasSave = rollOptions.some(o =>
    /^(origin:)?item:defense:(fortitude|reflex|will)$/.test(o)
  );
  if (hasSave) return true;
  const saveType = pf2e.context?.saveType ?? pf2e.strike?.saveType;
  return !!(saveType && { fortitude:1, reflex:1, will:1 }[saveType]);
}

function getTargetUuids(message) {
  const stored = message.flags?.[MODULE_ID]?.targetUuids;
  if (stored?.length) return stored;
  const authorId = message.author?.id ?? message.user?.id;
  const author   = game.users.get(authorId);
  if (!author) return [];
  return [...(author.targets ?? [])].map(t => t.document?.uuid).filter(Boolean);
}

// ============================================================
// Feature 2 — Damage Tray
// ============================================================

function findSystemButtons(messageId) {
  const li = document.querySelector(`li.chat-message[data-message-id="${messageId}"]`);
  if (!li) return null;
  const container = li.querySelector(".damage-application, .chat-damage-buttons");
  return container ?? null;
}

async function clickSystemButtonForToken(targetToken, systemBtn) {
  if (!canvas?.ready || !targetToken) return;
  const previouslyControlled = [...(canvas.tokens?.controlled ?? [])];
  try {
    canvas.tokens.releaseAll({ force: true });
    targetToken.control({ releaseOthers: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    systemBtn.dispatchEvent(new MouseEvent("click", {
      bubbles: true, cancelable: true, view: window,
    }));
    await new Promise(resolve => setTimeout(resolve, 50));
  } finally {
    canvas.tokens.releaseAll({ force: true });
    for (const t of previouslyControlled) {
      if (t.isOwner) t.control({ releaseOthers: false });
    }
  }
}

async function handleTrayButtonClick(messageId, tokenUuid, action, isLocalCall = true) {
  const token = tokenFromUuid(tokenUuid);
  if (!token) {
    ui.notifications.warn(`${MODULE_ID}: Could not find token on canvas.`);
    return;
  }
  if (!token.isOwner && !game.user.isGM) {
    game.socket.emit(SOCK, { action: "applyForTarget", messageId, tokenUuid, btnAction: action });
    return;
  }
  const container = findSystemButtons(messageId);
  if (!container) {
    ui.notifications.warn(`${MODULE_ID}: System damage buttons not found on message.`);
    return;
  }
  let systemBtn = null;
  if (action === "half") {
    systemBtn =
      container.querySelector("[data-action='apply-damage'][data-multiplier='0.5']") ??
      container.querySelector("[data-action='half-damage']") ??
      container.querySelector("button:nth-child(2)");
  } else if (action === "full") {
    systemBtn =
      container.querySelector("[data-action='apply-damage'][data-multiplier='1']") ??
      container.querySelector("[data-action='apply-damage']:not([data-multiplier])") ??
      container.querySelector("button:nth-child(1)");
  } else if (action === "double") {
    systemBtn =
      container.querySelector("[data-action='apply-damage'][data-multiplier='2']") ??
      container.querySelector("[data-action='double-damage']") ??
      container.querySelector("button:nth-child(3)");
  } else if (action === "shield") {
    systemBtn =
      container.querySelector("[data-action='shield-block']") ??
      container.querySelector("button:nth-child(4)");
  } else if (action === "heal") {
    systemBtn =
      container.querySelector("[data-action='apply-healing']") ??
      container.querySelector("[data-action='apply-damage'][data-multiplier='-1']") ??
      container.querySelector("button:last-child");
  }
  if (!systemBtn) {
    ui.notifications.warn(`${MODULE_ID}: Could not find system button for action "${action}".`);
    return;
  }
  await clickSystemButtonForToken(token, systemBtn);
  if (action === "shield") {
    if (!shieldActive.has(messageId)) shieldActive.set(messageId, new Set());
    const set = shieldActive.get(messageId);
    if (set.has(tokenUuid)) set.delete(tokenUuid);
    else set.add(tokenUuid);
  }
  refreshTargetRow(messageId, tokenUuid);
}

function refreshTargetRow(messageId, tokenUuid) {
  const li  = document.querySelector(`li.chat-message[data-message-id="${messageId}"]`);
  if (!li) return;
  const row = li.querySelector(`.ctote-target-row[data-uuid="${CSS.escape(tokenUuid)}"]`);
  if (!row) return;
  const actor = actorFromUuid(tokenUuid);
  if (actor && game.user.isGM) {
    const hpEl = row.querySelector(".ctote-target-hp");
    if (hpEl) hpEl.textContent = hpString(actor);
  }
  const shieldBtn = row.querySelector(".ctote-btn-shield");
  if (shieldBtn) {
    const isActive = shieldActive.get(messageId)?.has(tokenUuid) ?? false;
    shieldBtn.classList.toggle("ctote-shield-active", isActive);
    shieldBtn.title = isActive ? "Shield Block active — click to deactivate" : "Toggle Shield Block";
  }
}

function injectDamageTray(message, html) {
  if (!isPf2eDamageRoll(message)) return;
  const uuids = getTargetUuids(message);
  if (!uuids.length) return;
  const rows = uuids.map(uuid => {
    const actor = actorFromUuid(uuid);
    if (!actor) return "";
    const hp         = game.user.isGM ? hpString(actor) : "";
    const canControl = game.user.isGM || actor.isOwner;
    const dis        = canControl ? "" : "disabled";
    const msgId      = message.id;
    const isShield   = shieldActive.get(msgId)?.has(uuid) ?? false;
    const shCls      = isShield ? " ctote-shield-active" : "";
    return `
      <div class="ctote-target-row" data-uuid="${uuid}">
        <span class="ctote-target-name" data-uuid="${uuid}" title="${actor.name}">${actor.name}</span>
        <span class="ctote-target-hp">${hp}</span>
        <div class="ctote-btn-strip">
          <button class="ctote-btn ctote-btn-half"   data-uuid="${uuid}" data-action="half"   data-message="${msgId}" ${dis} title="½ damage">½</button>
          <button class="ctote-btn ctote-btn-full"   data-uuid="${uuid}" data-action="full"   data-message="${msgId}" ${dis} title="Full damage">×1</button>
          <button class="ctote-btn ctote-btn-double" data-uuid="${uuid}" data-action="double" data-message="${msgId}" ${dis} title="Double damage">×2</button>
          <button class="ctote-btn ctote-btn-shield${shCls}" data-uuid="${uuid}" data-action="shield" data-message="${msgId}" ${dis} title="${isShield ? "Shield Block active" : "Toggle Shield Block"}">🛡</button>
          <button class="ctote-btn ctote-btn-heal"   data-uuid="${uuid}" data-action="heal"   data-message="${msgId}" ${dis} title="Apply as healing">♥</button>
        </div>
      </div>`;
  }).join("");
  if (!rows) return;
  const trayHtml = `
    <div class="ctote-target-tray">
      <div class="ctote-tray-header">Apply to Targets</div>
      ${rows}
    </div>`;
  const tray = $(trayHtml);
  tray.find(".ctote-target-name").on("click", function () {
    const token = tokenFromUuid(this.dataset.uuid);
    if (token) token.actor?.sheet?.render(true);
  });
  tray.find(".ctote-btn[data-action]").on("click", async function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const { uuid, action, message: msgId } = this.dataset;
    if (!uuid || !action || !msgId) return;
    await handleTrayButtonClick(msgId, uuid, action, true);
  });
  const target = html.find(".message-content").length
    ? html.find(".message-content")
    : html;
  target.append(tray);
}

// Foundry v11–v13: html is a jQuery object
Hooks.on("renderChatMessage", (message, html) => {
  injectDamageTray(message, html);
});
// Foundry v14+: renderChatMessage is deprecated; html is now a plain HTMLElement
Hooks.on("renderChatMessageHTML", (message, html) => {
  injectDamageTray(message, $(html));
});

// ============================================================
// Feature 1 — Clear Targets on Turn End
// ============================================================

Hooks.on("combatTurn", (combat, updateData, options) => {
  if (options.direction !== undefined && options.direction < 0) return;
  const previousTurnIndex  = options.turn ?? (updateData.turn - 1);
  const turns              = combat.turns;
  const prevIndex          =
    previousTurnIndex >= 0 && previousTurnIndex < turns.length
      ? previousTurnIndex
      : turns.length - 1;
  const prevCombatant = turns[prevIndex];
  if (!prevCombatant?.actor) return;
  for (const user of game.users) {
    if (!user.active) continue;
    const level = prevCombatant.actor.getUserLevel(user);
    if (level < CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) continue;
    if (user.id === game.user.id) {
      game.user.targets.forEach(t =>
        t.setTarget(false, { user, releaseOthers: false, groupSelection: true })
      );
      game.user.targets.clear();
      console.log(`${MODULE_ID} | Cleared targets for local user "${user.name}".`);
    } else {
      game.socket.emit(SOCK, { action: "clearTargets", userId: user.id });
    }
  }
});

// ============================================================
// Socket listener & ready
// ============================================================

Hooks.on("ready", () => {
  console.log(`${MODULE_ID} | v2.0.0 loaded (system: ${game.system.id}).`);
  game.socket.on(SOCK, async (data) => {
    switch (data.action) {
      case "clearTargets": {
        if (data.userId !== game.user.id) return;
        game.user.targets.forEach(t =>
          t.setTarget(false, { user: game.user, releaseOthers: false, groupSelection: true })
        );
        game.user.targets.clear();
        console.log(`${MODULE_ID} | Cleared targets for "${game.user.name}" via socket.`);
        break;
      }
      case "applyForTarget": {
        if (!game.user.isGM) return;
        await handleTrayButtonClick(data.messageId, data.tokenUuid, data.btnAction, true);
        break;
      }
      case "applyAoeTargets": {
        if (data.userId !== game.user.id) return;
        applyAoeTargetList(data.tokenUuids);
        break;
      }
      case "reinjectSaveTrays": {
        if (data.userId === game.user.id) return;
        setTimeout(() => reinjectSaveTraysForCurrentTargets(), 150);
        break;
      }
      case "stampTemplateExpiry": {
        if (!game.user.isGM) return;
        const scene = game.scenes.get(data.sceneId);
        if (!scene) return;
        const tmplDoc = scene.templates.get(data.templateId);
        if (!tmplDoc) return;
        await tmplDoc.setFlag(MODULE_ID, "expiry", data.expiryData);
        break;
      }
    }
  });
});

// ============================================================
// Feature 3b — Template Auto-Expiry on combatTurn
// ============================================================

Hooks.on("combatTurn", async (combat, updateData, options) => {
  if (!game.user.isGM) return;
  if (options.direction !== undefined && options.direction < 0) return;
  const turns = combat.turns;
  const prevTurnIndex = options.turn ?? (updateData.turn - 1);
  const prevIndex =
    prevTurnIndex >= 0 && prevTurnIndex < turns.length
      ? prevTurnIndex
      : turns.length - 1;
  const roundRolled = (updateData.turn === 0);
  const endedRound  = roundRolled ? combat.round - 1 : combat.round;
  for (const scene of game.scenes) {
    for (const tmplDoc of scene.templates) {
      const expiry = tmplDoc.getFlag(MODULE_ID, "expiry");
      if (!expiry) continue;
      const { placedRound, placedTurn, placedCombatant, durationRounds } = expiry;
      const expiryRound = placedRound + durationRounds;
      const prevCombatant = turns[prevIndex];
      const turnMatches = placedCombatant
        ? prevCombatant?.id === placedCombatant
        : prevIndex === placedTurn;
      if (endedRound === expiryRound && turnMatches) {
        await tmplDoc.delete();
      }
    }
  }
});

// ============================================================
// Feature 3 — AoE Template Target Picker
// ============================================================

function getTokensInTemplate(templateDoc, tmplObj) {
  if (!canvas?.ready) return [];
  if (!tmplObj?.shape) return [];
  const { x: tx, y: ty } = templateDoc;
  const results = [];
  for (const token of canvas.tokens.placeables) {
    if (!token.visible && !game.user.isGM) continue;
    if (isTokenInTemplate(token, tmplObj, tx, ty)) results.push(token);
  }
  return results;
}

function isTokenInTemplate(token, tmpl, tx, ty) {
  const grid  = canvas.grid;
  const tileW = grid.sizeX ?? grid.w ?? grid.size ?? 100;
  const tileH = grid.sizeY ?? grid.h ?? grid.size ?? 100;
  const tokenW = token.document.width  ?? 1;
  const tokenH = token.document.height ?? 1;
  const cols = Math.max(1, Math.round(tokenW));
  const rows = Math.max(1, Math.round(tokenH));
  const points = [token.center];
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const px = token.x + (c + 0.5) * tileW;
      const py = token.y + (r + 0.5) * tileH;
      if (cols === 1 && rows === 1) break;
      points.push({ x: px, y: py });
    }
    if (cols === 1 && rows === 1) break;
  }
  for (const pt of points) {
    if (tmpl.shape.contains(pt.x - tx, pt.y - ty)) return true;
  }
  return false;
}

async function showAoePickerDialog(templateDoc, tokensInArea) {
  const alreadyTargeted = new Set([...game.user.targets].map(t => t.id));
  const sorted = [...tokensInArea].sort((a, b) => {
    const aT = alreadyTargeted.has(a.id) ? 0 : 1;
    const bT = alreadyTargeted.has(b.id) ? 0 : 1;
    if (aT !== bT) return aT - bT;
    return (a.name ?? "").localeCompare(b.name ?? "");
  });
  const rows = sorted.map(token => {
    const checked   = alreadyTargeted.has(token.id) ? "checked" : "";
    const imgSrc    = token.document.texture?.src ?? "icons/svg/mystery-man.svg";
    const isHidden  = token.document.hidden;
    if (!token.visible && !game.user.isGM) return "";
    const dispName  = token.document.name ?? token.name ?? "Unknown";
    const hiddenTag = isHidden ? ` <span class="ctote-aoe-hidden">(hidden)</span>` : "";
    return `
      <label class="ctote-aoe-row${isHidden ? " ctote-aoe-row-hidden" : ""}">
        <input type="checkbox" name="token" value="${token.id}" ${checked}>
        <img src="${imgSrc}" class="ctote-aoe-img" alt="">
        <span class="ctote-aoe-name">${dispName}${hiddenTag}</span>
      </label>`;
  }).join("");
  const content = `
    <div class="ctote-aoe-dialog">
      <p class="ctote-aoe-hint">Select the creatures affected by this area of effect:</p>
      <div class="ctote-aoe-list">
        ${rows || "<p><em>No tokens found in this area.</em></p>"}
      </div>
      <div class="ctote-aoe-footer">
        <button type="button" id="ctote-aoe-all">All</button>
        <button type="button" id="ctote-aoe-none">None</button>
      </div>
      <div class="ctote-aoe-duration">
        <label class="ctote-aoe-duration-label" for="ctote-aoe-rounds">
          Template duration (rounds):
          <span class="ctote-aoe-duration-hint">0 = expires at end of your current turn</span>
        </label>
        <input type="number" id="ctote-aoe-rounds" name="rounds" value="0" min="0" step="1">
      </div>
    </div>`;
  function readResult(root) {
    const checked = [...root.querySelectorAll("input[name='token']:checked")].map(el => el.value);
    const roundsEl = root.querySelector("#ctote-aoe-rounds");
    const rounds = Math.max(0, parseInt(roundsEl?.value) || 0);
    return { tokenIds: checked, rounds };
  }
  function wireButtons(root) {
    root.querySelector("#ctote-aoe-all")?.addEventListener("click", () => {
      root.querySelectorAll("input[name='token']").forEach(el => el.checked = true);
    });
    root.querySelector("#ctote-aoe-none")?.addEventListener("click", () => {
      root.querySelectorAll("input[name='token']").forEach(el => el.checked = false);
    });
  }
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (DialogV2) {
    return DialogV2.wait({
      window:  { title: "AoE Targets — Rasaec's QOL" },
      content,
      classes: ["ctote-aoe-dialog-app"],
      position: { width: 340 },
      buttons: [
        {
          action:  "ok",
          icon:    "fas fa-bullseye",
          label:   "Target Selected",
          default: true,
          callback: (_event, _btn, dialog) => readResult(dialog.element),
        },
        {
          action:   "cancel",
          icon:     "fas fa-times",
          label:    "Cancel",
          callback: () => null,
        },
      ],
      render: (_event, dialog) => wireButtons(dialog.element),
    }).catch(() => null);
  }
  return new Promise((resolve) => {
    const dlg = new Dialog({
      title:   "AoE Targets — Rasaec's QOL",
      content,
      buttons: {
        ok: {
          icon:     '<i class="fas fa-bullseye"></i>',
          label:    "Target Selected",
          callback: (html) => resolve(readResult(html[0])),
        },
        cancel: {
          icon:     '<i class="fas fa-times"></i>',
          label:    "Cancel",
          callback: () => resolve(null),
        },
      },
      default: "ok",
      render:  (html) => wireButtons(html[0]),
      close:   () => resolve(null),
    }, { width: 340 });
    dlg.render(true);
  });
}

function applyAoeTargetList(tokenIds) {
  game.user.targets.forEach(t =>
    t.setTarget(false, { user: game.user, releaseOthers: false, groupSelection: true })
  );
  game.user.targets.clear();
  for (const id of tokenIds) {
    const token = canvas.tokens.placeables.find(t => t.id === id);
    if (token) token.setTarget(true, { user: game.user, releaseOthers: false, groupSelection: true });
  }
}

function reinjectSaveTraysForCurrentTargets() {
  const recent = [...game.messages.contents].slice(-5).reverse();
  for (const message of recent) {
    if (!isSpellCardWithSave(message)) continue;
    const li = document.querySelector(`li.chat-message[data-message-id="${message.id}"]`);
    if (!li) continue;
    if (li.querySelector(".ctote-save-tray")) continue;
    const saveInfo = getSaveInfoFromMessage(message);
    if (!saveInfo) continue;
    const authorId = message.author?.id ?? message.user?.id;
    const author   = game.users.get(authorId);
    const uuids    = [...(author?.targets ?? [])].map(t => t.document?.uuid).filter(Boolean);
    const storedUuids = message.flags?.[MODULE_ID]?.targetUuids ?? [];
    const finalUuids  = uuids.length ? uuids : storedUuids;
    if (!finalUuids.length) continue;
    const originUuid = message.flags?.pf2e?.origin?.actor ?? null;
    const tray = buildSaveTray(finalUuids, saveInfo.saveType, saveInfo.dc, message.id, originUuid);
    if (tray.length) {
      const msgContent = li.querySelector(".message-content");
      if (msgContent) msgContent.appendChild(tray[0]);
    }
  }
}

async function waitForTemplateObject(templateDoc, maxMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const obj = templateDoc.object;
    if (obj?.shape) return obj;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  return null;
}

async function onTemplatePlaced(templateDoc, _options, userId) {
  const pf2eOriginId = templateDoc.flags?.pf2e?.origin?.userId;
  const authorId     = templateDoc.author?.id;
  const placingUserId = pf2eOriginId ?? authorId ?? userId;
  if (placingUserId !== game.user.id) return;
  const tmplObj = await waitForTemplateObject(templateDoc);
  if (!tmplObj) return;
  const tokensInArea = getTokensInTemplate(templateDoc, tmplObj);
  const result = await showAoePickerDialog(templateDoc, tokensInArea);
  if (result === null) return;
  const { tokenIds, rounds } = result;
  applyAoeTargetList(tokenIds);
  setTimeout(() => reinjectSaveTraysForCurrentTargets(), 100);
  game.socket.emit(SOCK, { action: "reinjectSaveTrays", userId: game.user.id });
  if (game.combat?.started) {
    const combat      = game.combat;
    const currentCombatant = combat.turns[combat.turn];
    const expiryData  = {
      placedRound:      combat.round,
      placedTurn:       combat.turn,
      placedCombatant:  currentCombatant?.id ?? null,
      durationRounds:   rounds,
      sceneId:          canvas.scene.id,
    };
    if (game.user.isGM) {
      await templateDoc.setFlag(MODULE_ID, "expiry", expiryData);
    } else {
      game.socket.emit(SOCK, {
        action:     "stampTemplateExpiry",
        templateId: templateDoc.id,
        sceneId:    canvas.scene.id,
        expiryData,
      });
    }
  }
}

Hooks.on("createMeasuredTemplateDocument", onTemplatePlaced);
Hooks.on("createMeasuredTemplate",         onTemplatePlaced);

// ============================================================
// Feature 4 — Per-Target Saving Throw Buttons
// ============================================================

const SAVE_LABELS = { fortitude: "Fortitude", reflex: "Reflex", will: "Will" };

function getSaveInfoFromMessage(message) {
  const pf2e = message.flags?.pf2e;
  if (!pf2e) return null;
  let saveType = null;
  const rollOptions = pf2e.origin?.rollOptions ?? pf2e.context?.options ?? [];
  for (const opt of rollOptions) {
    const m = opt.match(/^(?:origin:)?item:defense:(fortitude|reflex|will)$/);
    if (m) { saveType = m[1]; break; }
  }
  if (!saveType) saveType = pf2e.context?.saveType ?? pf2e.strike?.saveType ?? null;
  if (!saveType || !SAVE_LABELS[saveType]) return null;
  let dc = pf2e.context?.dc?.value ?? pf2e.casting?.dc?.value ?? null;
  if (dc != null) return { saveType, dc };
  if (pf2e.origin?.uuid) {
    try {
      const item = fromUuidSync(pf2e.origin.uuid);
      if (item) {
        const itemDC =
          item.spellcasting?.statistic?.dc?.value ??
          item.parent?.spellcasting?.find?.(e => e.id === pf2e.casting?.id)?.statistic?.dc?.value ??
          null;
        if (itemDC) dc = itemDC;
      }
    } catch (e) { console.warn(`${MODULE_ID} | item lookup failed`, e); }
  }
  if (dc == null && pf2e.origin?.actor) {
    try {
      const originActor = fromUuidSync(pf2e.origin.actor);
      if (originActor) {
        const entries = originActor.spellcasting?.contents ?? [];
        const castingId = pf2e.casting?.id;
        const matchedEntry = castingId ? entries.find(e => e.id === castingId) : entries[0];
        const entryDC = matchedEntry?.statistic?.dc?.value ?? null;
        if (entryDC) {
          dc = entryDC;
        } else {
          dc = originActor.classDC?.value ??
               originActor.system?.attributes?.classOrSpellDC?.value ??
               originActor.system?.attributes?.spellDC?.value ??
               null;
        }
      }
    } catch (e) { console.warn(`${MODULE_ID} | actor lookup failed`, e); }
  }
  return { saveType, dc };
}

async function rollSaveForToken(tokenUuid, saveType, dc, originActorUuid) {
  const tokenDoc = fromUuidSync(tokenUuid);
  const actor    = tokenDoc?.actor;
  if (!actor) { ui.notifications.warn(`${MODULE_ID}: Could not find actor for save.`); return; }
  const saveStatistic = actor.saves?.[saveType];
  if (!saveStatistic) { ui.notifications.warn(`${MODULE_ID}: ${actor.name} has no ${saveType} save.`); return; }
  const rollOptions = {};
  if (dc != null) rollOptions.dc = { value: Number(dc) };
  if (originActorUuid) {
    try {
      const originDoc = fromUuidSync(originActorUuid);
      if (originDoc?.actor ?? originDoc) rollOptions.origin = originDoc?.actor ?? originDoc;
    } catch { /* ignore */ }
  }
  await saveStatistic.roll(rollOptions);
}

function buildSaveTray(tokenUuids, saveType, dc, messageId, originActorUuid) {
  const saveLabel = SAVE_LABELS[saveType] ?? saveType;
  const dcLabel   = dc != null ? ` (DC ${dc})` : "";
  const rows = tokenUuids.flatMap(uuid => {
    const actor = actorFromUuid(uuid);
    if (!actor) return [];
    if (!actor.visible && !game.user.isGM) return [];
    const canRoll = game.user.isGM || actor.isOwner;
    const dis     = canRoll ? "" : "disabled";
    const name    = actor.name ?? "Unknown";
    const imgSrc  = (() => {
      try { return fromUuidSync(uuid)?.texture?.src ?? "icons/svg/d20-black.svg"; }
      catch { return "icons/svg/d20-black.svg"; }
    })();
    return [`
      <div class="ctote-save-row" data-uuid="${uuid}">
        <img src="${imgSrc}" class="ctote-save-img" alt="">
        <span class="ctote-save-name" title="${name}">${name}</span>
        <button class="ctote-save-btn"
          data-uuid="${uuid}"
          data-save-type="${saveType}"
          data-dc="${dc ?? ""}"
          data-message-id="${messageId}"
          data-origin="${originActorUuid ?? ""}"
          ${dis}
          title="Roll ${saveLabel} save${dcLabel} for ${name}">
          ${saveLabel}${dcLabel}
        </button>
      </div>`];
  }).join("");
  if (!rows) return $();
  const tray = $(`
    <div class="ctote-save-tray">
      <div class="ctote-save-tray-header">
        <i class="fas fa-dice-d20"></i> Saving Throws — ${saveLabel}${dcLabel}
      </div>
      ${rows}
    </div>`);
  tray.find(".ctote-save-btn").on("click", async function(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const { uuid, saveType, dc, messageId, origin } = this.dataset;
    const dcVal = dc ? Number(dc) : null;
    const actor = actorFromUuid(uuid);
    if (!actor) return;
    if (actor.isOwner || game.user.isGM) {
      await rollSaveForToken(uuid, saveType, dcVal, origin || null);
    } else {
      game.socket.emit(SOCK, {
        action: "rollSaveForTarget", tokenUuid: uuid, saveType,
        dc: dcVal, originActorUuid: origin || null, userId: game.user.id,
      });
    }
  });
  return tray;
}

function injectSaveTray(message, html) {
  const isSpellSave = isSpellCardWithSave(message);
  if (!isSpellSave) return;
  const saveInfo = getSaveInfoFromMessage(message);
  if (!saveInfo) return;
  const authorId  = message.author?.id ?? message.user?.id;
  const author    = game.users.get(authorId);
  const liveUuids = [...(author?.targets ?? [])].map(t => t.document?.uuid).filter(Boolean);
  const storedUuids = message.flags?.[MODULE_ID]?.targetUuids ?? [];
  const uuids = liveUuids.length ? liveUuids : storedUuids;
  if (!uuids.length) return;
  const originUuid = message.flags?.pf2e?.origin?.actor ?? null;
  const tray = buildSaveTray(uuids, saveInfo.saveType, saveInfo.dc, message.id, originUuid);
  if (tray.length) html.find(".message-content").append(tray);
}

// Foundry v11–v13: html is a jQuery object
Hooks.on("renderChatMessage", (message, html) => {
  injectSaveTray(message, html);
});
// Foundry v14+: renderChatMessage is deprecated; html is now a plain HTMLElement
Hooks.on("renderChatMessageHTML", (message, html) => {
  injectSaveTray(message, $(html));
});

// ── 4B: Socket handler for enemy saves ──────────────────────────────────────
Hooks.on("ready", () => {
  game.socket.on(SOCK, async (data) => {
    if (data.action !== "rollSaveForTarget") return;
    if (!game.user.isGM) return;
    await rollSaveForToken(data.tokenUuid, data.saveType, data.dc, data.originActorUuid);
  });
});
