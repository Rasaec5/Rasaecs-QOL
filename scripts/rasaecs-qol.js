/**
 * Rasaec's QOL — v2.2.0
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
 *
 * Feature 5: Save-Result → Damage Tray Highlighting
 *   When a PF2e saving throw result appears in chat, the matching damage multiplier
 *   button is highlighted in every damage-tray row for that token:
 *     Critical Success → all damage buttons dimmed (0 damage)
 *     Success          → ½ button highlighted
 *     Failure          → ×1 button highlighted
 *     Critical Failure → ×2 button highlighted
 *   Results are cached for 5 minutes so that a damage roll posted after the save
 *   also receives the correct highlight immediately on render.
 */

const MODULE_ID  = "rasaecs-qol";
const SOCK       = `module.${MODULE_ID}`;

// ─── Per-message shield-block state (client-local Map<messageId, Set<tokenUuid>>) ──
const shieldActive = new Map();

// ─── Feature 6: spell-card hold until AoE targeting completes ────────────────
// When a spell with a save is cast, the PF2e system posts the chat card before
// the player has placed (or confirmed targets in) an AoE template.  We hide
// the card immediately on the caster's client and release it — with the save
// tray already populated — once the AoE picker dialog resolves.
const pendingSpellCards  = new Set();       // Set<messageId>
const SPELL_CARD_HOLD_MS = 10_000;          // safety release after 10 s

function _hideSpellCard(messageId) {
  const li = document.querySelector(`li.chat-message[data-message-id="${messageId}"]`);
  if (!li || li.dataset.ctoteHeld) return;
  li.dataset.ctoteHeld = "1";
  li.style.display = "none";
  pendingSpellCards.add(messageId);
}

function _releaseSpellCard(messageId) {
  pendingSpellCards.delete(messageId);
  const li = document.querySelector(`li.chat-message[data-message-id="${messageId}"]`);
  if (!li) return;
  delete li.dataset.ctoteHeld;
  li.style.display = "";
  // Re-run save-tray injection now that targets should be populated.
  const message = game.messages.get(messageId);
  if (message) injectSaveTray(message, $(li));
}

function releaseAllHeldSpellCards() {
  for (const id of [...pendingSpellCards]) _releaseSpellCard(id);
}

// ─── Feature 5: save-result cache (tokenUuid → { outcome, expiresAt }) ─────────
const saveResultCache   = new Map();
const SAVE_RESULT_TTL   = 5 * 60 * 1000; // 5 minutes

/**
 * For basic saves, maps PF2e outcome strings to the damage button to highlight.
 * null = critical success (0 damage) — dim all damage buttons instead.
 */
const BASIC_SAVE_DAMAGE_MAP = {
  criticalSuccess: null,    // 0 damage — dim damage buttons
  success:         "half",
  failure:         "full",
  criticalFailure: "double",
};

// ============================================================
// Utilities
// ============================================================

/** Resolve a TokenDocument → Token (placeable) from a UUID, safely. */
function tokenFromUuid(uuid) {
  try {
    const doc = fromUuidSync(uuid);
    // doc may be a TokenDocument; get its on-canvas object
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

/**
 * Get HP display string for an actor.
 * Handles PF2e's actor.system.attributes.hp and SF2e equivalents.
 */
function hpString(actor) {
  const hp = actor?.system?.attributes?.hp;
  if (!hp) return "? / ?";
  const sp = actor?.system?.attributes?.sp; // Starfinder stamina
  if (sp) {
    return `HP ${hp.value}/${hp.max}  SP ${sp.value}/${sp.max}`;
  }
  return `${hp.value} / ${hp.max}`;
}

/**
 * Return true if this chat message is a PF2e typed damage roll.
 * PF2e stores DamageRoll instances in message.rolls[]; each has .constructor.name
 * === "DamageRoll" and carries typed damage terms in .instances[].
 */
function isPf2eDamageRoll(message) {
  if (!message.rolls?.length) return false;
  const roll = message.rolls[0];
  // PF2e's DamageRoll class
  if (roll?.constructor?.name === "DamageRoll") return true;
  // Fallback: check the pf2e flag that the system sets on all damage messages
  if (message.flags?.pf2e?.context?.type === "damage-roll") return true;
  if (message.flags?.pf2e?.damageRoll) return true;
  return false;
}

/**
 * Determine if a chat message is a pf2e spell/item usage card with a saving throw.
 * Placed here so createChatMessage can call it before Feature 4 code is reached.
 */
function isSpellCardWithSave(message) {
  const pf2e = message.flags?.pf2e;
  if (!pf2e) return false;

  // Exclude damage rolls
  if (isPf2eDamageRoll(message)) return false;

  // Exclude saving throw results, skill checks, and attack rolls — these
  // carry the same origin rollOptions as the spell that triggered them,
  // which is exactly what caused the false-positive tray on save results.
  const contextType = pf2e.context?.type ?? "";
  const EXCLUDED = ["saving-throw", "skill-check", "attack-roll", "perception-check"];
  if (EXCLUDED.includes(contextType)) return false;

  // Must be a spell-cast or item-use context
  const ALLOWED = ["spell-cast", "spell-attack", ""];
  // Empty string covers older message shapes with no context.type set
  if (!ALLOWED.includes(contextType)) return false;

  // Must have a defense (save) in the roll options
  const rollOptions = pf2e.origin?.rollOptions ?? pf2e.context?.options ?? [];
  const hasSave = rollOptions.some(o =>
    /^(origin:)?item:defense:(fortitude|reflex|will)$/.test(o)
  );
  if (hasSave) return true;

  // Fallback for older message shapes
  const saveType = pf2e.context?.saveType ?? pf2e.strike?.saveType;
  return !!(saveType && { fortitude:1, reflex:1, will:1 }[saveType]);
}

/** Pull stored target UUIDs from message flags, falling back to author's live targets. */
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

/**
 * The system renders its own damage buttons inside an element like:
 *   <div class="damage-application">
 *     <button data-action="apply-damage" data-multiplier="0.5">…</button>  ← half
 *     <button data-action="apply-damage" data-multiplier="1">…</button>    ← full
 *     <button data-action="apply-damage" data-multiplier="2">…</button>    ← double
 *     <button data-action="shield-block">…</button>
 *     <button data-action="apply-healing">…</button>
 *   </div>
 *
 * We locate these buttons on the live DOM element for the message, temporarily
 * swap the canvas selection to just our target token, click the correct button,
 * then restore. This passes typed damage through the system's full IWR pipeline.
 */

/**
 * Find the system's button container in the rendered chat message li element.
 * Returns null if the system hasn't rendered them yet or they don't exist.
 */
function findSystemButtons(messageId) {
  const li = document.querySelector(`li.chat-message[data-message-id="${messageId}"]`);
  if (!li) return null;
  // The system puts buttons in .damage-application or .chat-damage-buttons
  const container = li.querySelector(".damage-application, .chat-damage-buttons");
  return container ?? null;
}

/**
 * Swap canvas token selection to `targetToken`, fire a synthetic click on
 * `systemBtn`, then restore the original selection.
 * Returns a Promise that resolves after the click has been processed.
 */
async function clickSystemButtonForToken(targetToken, systemBtn) {
  if (!canvas?.ready || !targetToken) return;

  // Save current selection
  const previouslyControlled = [...(canvas.tokens?.controlled ?? [])];

  try {
    // Release all, then select only our target
    canvas.tokens.releaseAll({ force: true });
    targetToken.control({ releaseOthers: true });

    // Tiny yield so the system's click handler can read canvas.tokens.controlled
    await new Promise(resolve => setTimeout(resolve, 0));

    // Fire a left-click MouseEvent on the system button
    systemBtn.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
    }));

    // Brief yield to let the async apply pipeline start
    await new Promise(resolve => setTimeout(resolve, 50));
  } finally {
    // Restore previous selection
    canvas.tokens.releaseAll({ force: true });
    for (const t of previouslyControlled) {
      if (t.isOwner) t.control({ releaseOthers: false });
    }
  }
}

/**
 * Main entry point for a button click in our tray.
 *
 * @param {string}  messageId   - The chat message id
 * @param {string}  tokenUuid   - UUID of the target TokenDocument
 * @param {string}  action      - "half" | "full" | "double" | "shield" | "heal"
 * @param {boolean} isLocalCall - true when we're already on the right client
 */
async function handleTrayButtonClick(messageId, tokenUuid, action, isLocalCall = true) {
  const token = tokenFromUuid(tokenUuid);
  if (!token) {
    ui.notifications.warn(`${MODULE_ID}: Could not find token on canvas.`);
    return;
  }

  // If we can't control this token, ask the GM to do it
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
      container.querySelector("button:nth-child(2)");  // system renders full first, half second
  } else if (action === "full") {
    systemBtn =
      container.querySelector("[data-action='apply-damage'][data-multiplier='1']") ??
      container.querySelector("[data-action='apply-damage']:not([data-multiplier])") ??
      container.querySelector("button:nth-child(1)");  // system renders full first
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

  // Update shield state in our local tracker
  if (action === "shield") {
    if (!shieldActive.has(messageId)) shieldActive.set(messageId, new Set());
    const set = shieldActive.get(messageId);
    if (set.has(tokenUuid)) set.delete(tokenUuid);
    else set.add(tokenUuid);
  }

  // Re-render our tray row to update HP and shield button appearance.
  // We do this by finding the row in the DOM and updating it in place.
  refreshTargetRow(messageId, tokenUuid);
}

/**
 * Update the HP text and shield-active class on an already-rendered row,
 * so users get live HP feedback without a full message re-render.
 */
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

/**
 * Build and inject the tray HTML into a damage roll chat card.
 * Called from renderChatMessage.
 */
function injectDamageTray(message, html) {
  if (!isPf2eDamageRoll(message)) return;

  const uuids = getTargetUuids(message);
  if (!uuids.length) return;

  // Build rows — only for targets we can resolve
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
          <button class="ctote-btn ctote-btn-half"   data-uuid="${uuid}" data-action="half"   data-message="${msgId}" ${dis} title="½ damage (basic save success / resistance)">½</button>
          <button class="ctote-btn ctote-btn-full"   data-uuid="${uuid}" data-action="full"   data-message="${msgId}" ${dis} title="Full damage">×1</button>
          <button class="ctote-btn ctote-btn-double" data-uuid="${uuid}" data-action="double" data-message="${msgId}" ${dis} title="Double damage (critical hit)">×2</button>
          <button class="ctote-btn ctote-btn-shield${shCls}" data-uuid="${uuid}" data-action="shield" data-message="${msgId}" ${dis} title="${isShield ? "Shield Block active — click to deactivate" : "Toggle Shield Block"}">🛡</button>
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

  // Pan/highlight on name click
  tray.find(".ctote-target-name").on("click", function () {
    const token = tokenFromUuid(this.dataset.uuid);
    if (token) {
      token.actor?.sheet?.render(true);
    }
  });

  // Damage/heal button clicks
  tray.find(".ctote-btn[data-action]").on("click", async function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const { uuid, action, message: msgId } = this.dataset;
    if (!uuid || !action || !msgId) return;
    await handleTrayButtonClick(msgId, uuid, action, true);
  });

  // Append after .message-content (or at end of the card)
  const target = html.find(".message-content").length
    ? html.find(".message-content")
    : html;
  target.append(tray);

  // Feature 5: apply any cached save-result highlights for these tokens
  for (const uuid of uuids) {
    const cached = saveResultCache.get(uuid);
    if (cached && cached.expiresAt > Date.now()) {
      applyDamageTrayHighlight(uuid, cached.outcome);
    }
  }
}

// ============================================================
// Note: We no longer try to stamp targets at message creation time.
// PF2e creates spell-cast messages server-side before the user has set
// targets via the AoE picker, so there is nothing to stamp at that point.
// Instead, renderChatMessage reads game.user.targets live at render time.

// ============================================================
// Hook: renderChatMessage — inject tray
// ============================================================

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
  // Only fire on forward advancement
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
      // Clear locally
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
  console.log(`${MODULE_ID} | v2.2.0 loaded (system: ${game.system.id}).`);

  game.socket.on(SOCK, async (data) => {
    switch (data.action) {

      // ── Feature 1: clear a remote user's targets ──────────────────────────
      case "clearTargets": {
        if (data.userId !== game.user.id) return;
        game.user.targets.forEach(t =>
          t.setTarget(false, { user: game.user, releaseOthers: false, groupSelection: true })
        );
        game.user.targets.clear();
        console.log(`${MODULE_ID} | Cleared targets for "${game.user.name}" via socket.`);
        break;
      }

      // ── Feature 2b: GM applies damage on behalf of a player ──────────────
      // (Only needed when the target token is not owned by the requesting player,
      //  i.e. the player targeted an enemy. The GM's canvas can control any token.)
      case "applyForTarget": {
        if (!game.user.isGM) return;
        await handleTrayButtonClick(data.messageId, data.tokenUuid, data.btnAction, true);
        break;
      }

      // ── Feature 3: apply targeting selections from another client ─────────
      case "applyAoeTargets": {
        if (data.userId !== game.user.id) return;
        applyAoeTargetList(data.tokenUuids);
        break;
      }

      // ── Feature 4: re-inject save trays after targets confirmed elsewhere ─
      case "reinjectSaveTrays": {
        // Run on all clients EXCEPT the one that already ran it locally
        if (data.userId === game.user.id) return;
        setTimeout(() => reinjectSaveTraysForCurrentTargets(), 150);
        break;
      }

      // ── Feature 3b: GM stamps expiry flags on a template ─────────────────
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

/**
 * Determine whether a template should be deleted at the end of the turn
 * that just finished.
 *
 * Logic:
 *   - "0 rounds" → delete at the end of the turn in which it was placed
 *     (i.e. when prevTurn === placedTurn && combat.round === placedRound)
 *   - "N rounds" → delete at the end of the same combatant's turn N rounds later
 *     (i.e. when prevTurn === placedTurn && combat.round === placedRound + N)
 *
 * Only the GM deletes — this hook only acts on the GM client.
 */
Hooks.on("combatTurn", async (combat, updateData, options) => {
  // Only the active GM should delete templates
  if (!game.user.isGM) return;
  // Only fire on forward advancement
  if (options.direction !== undefined && options.direction < 0) return;

  const turns = combat.turns;

  // In the combatTurn hook:
  //   options.turn   = the turn index BEFORE the advance (what just ended)
  //   updateData.turn = the turn index AFTER the advance (what is starting)
  //   combat.round    = the round AFTER the advance (already updated)
  //
  // We need to know which round and turn just ENDED, so we reconstruct them:
  //   - The turn that ended is options.turn (if available) otherwise updateData.turn - 1
  //   - If options.turn was the last turn in the round, the round that ended
  //     is combat.round - 1 (because combat.round already incremented)
  //     Otherwise the round that ended is combat.round (same round, mid-way through)

  const prevTurnIndex = options.turn ?? (updateData.turn - 1);
  const prevIndex =
    prevTurnIndex >= 0 && prevTurnIndex < turns.length
      ? prevTurnIndex
      : turns.length - 1;

  // Did a round rollover just happen?
  // A rollover occurs when updateData.turn === 0 (we wrapped back to start)
  const roundRolled = (updateData.turn === 0);
  // The round that just ENDED
  const endedRound  = roundRolled ? combat.round - 1 : combat.round;

  console.log(`${MODULE_ID} | combatTurn expiry check — endedRound:${endedRound} prevIndex:${prevIndex} currentRound:${combat.round} roundRolled:${roundRolled}`);

  // Check all templates in all scenes for expiry
  for (const scene of game.scenes) {
    for (const tmplDoc of scene.templates) {
      const expiry = tmplDoc.getFlag(MODULE_ID, "expiry");
      if (!expiry) continue;

      const { placedRound, placedTurn, placedCombatant, durationRounds } = expiry;
      const expiryRound = placedRound + durationRounds;

      // Match by combatant ID if available, fall back to turn index
      const prevCombatant = turns[prevIndex];
      const turnMatches = placedCombatant
        ? prevCombatant?.id === placedCombatant
        : prevIndex === placedTurn;

      console.log(`${MODULE_ID} | Template ${tmplDoc.id} — placedR:${placedRound} expiryR:${expiryRound} endedR:${endedRound} combatantMatch:${turnMatches}`);

      if (endedRound === expiryRound && turnMatches) {
        console.log(`${MODULE_ID} | Deleting expired template ${tmplDoc.id}`);
        await tmplDoc.delete();
      }
    }
  }
});

// ============================================================
// Feature 3 — AoE Template Target Picker
// ============================================================

/**
 * Given a MeasuredTemplateDocument, return all Token placeables whose
 * centre point falls inside the template's shape.
 *
 * The template's PIXI shape (circle, cone, rectangle, ray) is always
 * defined in local space relative to the template's origin (x, y).
 * We therefore translate each token centre into that local space before
 * calling shape.contains().
 *
 * For large tokens we test multiple points (each occupied grid cell centre)
 * so that a token is included if *any* part of it overlaps the template.
 */
function getTokensInTemplate(templateDoc, tmplObj) {
  if (!canvas?.ready) return [];
  if (!tmplObj?.shape) return [];

  const { x: tx, y: ty } = templateDoc;
  const results = [];

  for (const token of canvas.tokens.placeables) {
    // Skip tokens that are not visible to the current user.
    // token.visible accounts for hidden flag, fog of war, and vision settings.
    // GMs always see everything.
    if (!token.visible && !game.user.isGM) continue;

    if (isTokenInTemplate(token, tmplObj, tx, ty)) {
      results.push(token);
    }
  }

  return results;
}

/**
 * Test whether a token overlaps a template's shape.
 *
 * Strategy: for any token, generate a dense grid of test points covering
 * its full bounding footprint (one point per occupied grid cell centre, plus
 * the token's own centre). If ANY point falls inside the template shape the
 * token is considered "in". This correctly handles:
 *   - Large multi-square tokens (dragon, etc.) whose centre may be outside
 *     the burst even though part of their body is inside.
 *   - Single-square tokens at any position.
 */
function isTokenInTemplate(token, tmpl, tx, ty) {
  const grid  = canvas.grid;
  const tileW = grid.sizeX ?? grid.w ?? grid.size ?? 100;
  const tileH = grid.sizeY ?? grid.h ?? grid.size ?? 100;

  const tokenW = token.document.width  ?? 1;
  const tokenH = token.document.height ?? 1;

  const cols = Math.max(1, Math.round(tokenW));
  const rows = Math.max(1, Math.round(tokenH));

  // Always include the token's computed centre (handles non-grid-aligned tokens)
  const points = [token.center];

  // Add the centre of every occupied grid cell
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const px = token.x + (c + 0.5) * tileW;
      const py = token.y + (r + 0.5) * tileH;
      // Avoid duplicating the centre point we already added
      if (cols === 1 && rows === 1) break;
      points.push({ x: px, y: py });
    }
    if (cols === 1 && rows === 1) break;
  }

  // Token is "in" if any test point lies inside the template's local shape
  for (const pt of points) {
    if (tmpl.shape.contains(pt.x - tx, pt.y - ty)) return true;
  }

  return false;
}

/**
 * Build and show the AoE target-picker dialog.
 *
 * @param {MeasuredTemplateDocument} templateDoc
 * @param {Token[]}                  tokensInArea
 */
async function showAoePickerDialog(templateDoc, tokensInArea) {
  // Pre-check any token the user already has targeted
  const alreadyTargeted = new Set(
    [...game.user.targets].map(t => t.id)
  );

  // Build checkbox rows, sorting: already-targeted first, then by name
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

    // Extra guard: never show a non-visible token to a non-GM player.
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

  // ── Helper: read result from a rendered dialog root element ────────────
  function readResult(root) {
    const checked = [...root.querySelectorAll("input[name='token']:checked")]
      .map(el => el.value);
    const roundsEl = root.querySelector("#ctote-aoe-rounds");
    const rounds = Math.max(0, parseInt(roundsEl?.value) || 0);
    return { tokenIds: checked, rounds };
  }

  // ── Helper: wire All / None buttons ─────────────────────────────────────
  function wireButtons(root) {
    root.querySelector("#ctote-aoe-all")?.addEventListener("click", () => {
      root.querySelectorAll("input[name='token']").forEach(el => el.checked = true);
    });
    root.querySelector("#ctote-aoe-none")?.addEventListener("click", () => {
      root.querySelectorAll("input[name='token']").forEach(el => el.checked = false);
    });
  }

  // ── DialogV2 (Foundry v13+) ──────────────────────────────────────────────
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
    }).catch(() => null);  // dismissed counts as cancel
  }

  // ── Dialog v1 fallback (Foundry v11–v12) ────────────────────────────────
  return new Promise((resolve) => {
    // eslint-disable-next-line no-undef
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

/**
 * Apply a list of token IDs as the current user's targets.
 * Called both locally and via socket (for players on remote clients).
 *
 * @param {string[]} tokenIds
 */
function applyAoeTargetList(tokenIds) {
  // Release all current targets first
  game.user.targets.forEach(t =>
    t.setTarget(false, { user: game.user, releaseOthers: false, groupSelection: true })
  );
  game.user.targets.clear();

  // Set the new ones
  for (const id of tokenIds) {
    const token = canvas.tokens.placeables.find(t => t.id === id);
    if (token) {
      token.setTarget(true, { user: game.user, releaseOthers: false, groupSelection: true });
    }
  }
}

/**
 * After the AoE picker sets targets, scan the last few chat messages for
 * spell cards with saves and inject save trays into any that are missing one.
 * This handles the race where PF2e renders the spell card before the user
 * has confirmed their targets via the AoE picker.
 */
function reinjectSaveTraysForCurrentTargets() {
  // Look at the most recent 5 messages for a matching spell card
  const recent = [...game.messages.contents].slice(-5).reverse();
  for (const message of recent) {
    if (!isSpellCardWithSave(message)) continue;

    // Find its rendered li in the chat log
    const li = document.querySelector(`li.chat-message[data-message-id="${message.id}"]`);
    if (!li) continue;

    // Skip if we already injected a tray
    if (li.querySelector(".ctote-save-tray")) continue;

    const saveInfo = getSaveInfoFromMessage(message);
    if (!saveInfo) continue;

    // Use the author's current live targets; if empty, skip
    // (this function is called shortly after targets are set on the author's client,
    //  so live targets should be populated; on other clients we rely on the timing)
    const authorId = message.author?.id ?? message.user?.id;
    const author   = game.users.get(authorId);
    const uuids    = [...(author?.targets ?? [])].map(t => t.document?.uuid).filter(Boolean);
    // Also check stored flags as fallback
    const storedUuids = message.flags?.[MODULE_ID]?.targetUuids ?? [];
    const finalUuids  = uuids.length ? uuids : storedUuids;
    if (!finalUuids.length) continue;

    const originUuid = message.flags?.pf2e?.origin?.actor ?? null;
    const tray = buildSaveTray(finalUuids, saveInfo.saveType, saveInfo.dc, message.id, originUuid);

    if (tray.length) {
      const msgContent = li.querySelector(".message-content");
      if (msgContent) {
        msgContent.appendChild(tray[0]);
        console.log(`${MODULE_ID} | reinjectSaveTraysForCurrentTargets — injected tray into message ${message.id}`);
      }
    }
  }
}

/**
 * Wait until templateDoc.object is drawn and has a shape, polling up to
 * maxMs milliseconds. Returns the MeasuredTemplate placeable or null.
 */
async function waitForTemplateObject(templateDoc, maxMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const obj = templateDoc.object;
    if (obj?.shape) return obj;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  return null;
}

/**
 * Main entry point for template creation.
 */
// Foundry v9-v11 uses "createMeasuredTemplateDocument",
// Foundry v12+ uses "createMeasuredTemplate" (Document suffix dropped).
// We register both so it fires on any version.
async function onTemplatePlaced(templateDoc, _options, userId) {
  // ── Diagnostics: log everything so we can debug ──────────────────────────
  const pf2eOriginId = templateDoc.flags?.pf2e?.origin?.userId;
  const authorId     = templateDoc.author?.id;
  const docUserId    = authorId; // .user is deprecated in v12+, use .author
  console.log(
    `${MODULE_ID} | onTemplatePlaced fired.`,
    `\n  hook userId arg : ${userId}`,
    `\n  game.user.id    : ${game.user.id}`,
    `\n  pf2e origin id  : ${pf2eOriginId}`,
    `\n  author.id       : ${authorId}`,
    `\n  doc user.id     : ${docUserId}`,
    `\n  template type   : ${templateDoc.type}`,
  );

  // Resolve who placed this template — try every possible field
  const placingUserId = pf2eOriginId ?? authorId ?? docUserId ?? userId;

  // Guard: only show the dialog on the placing user's client
  if (placingUserId !== game.user.id) {
    console.log(`${MODULE_ID} | AoE picker: skipping — placingUserId (${placingUserId}) !== game.user.id (${game.user.id})`);
    return;
  }

  console.log(`${MODULE_ID} | AoE picker: user matches — waiting for template object...`);

  // Wait for the canvas to draw the template placeable
  const tmplObj = await waitForTemplateObject(templateDoc);
  if (!tmplObj) {
    console.warn(`${MODULE_ID} | AoE picker: template object never became ready after 2s.`);
    return;
  }

  console.log(`${MODULE_ID} | AoE picker: template ready. Canvas tokens: ${canvas.tokens.placeables.length}`);

  const tokensInArea = getTokensInTemplate(templateDoc, tmplObj);
  console.log(`${MODULE_ID} | AoE picker: ${tokensInArea.length} token(s) in template area.`);

  const result = await showAoePickerDialog(templateDoc, tokensInArea);
  if (result === null) {
    // User cancelled — release any held spell cards immediately so they
    // appear in chat without a save tray (better than staying hidden).
    releaseAllHeldSpellCards();
    return;
  }

  const { tokenIds, rounds } = result;
  applyAoeTargetList(tokenIds);

  // Feature 6: Release any held spell cards now that targets are set, then
  // inject save trays.  A 50 ms tick gives setTarget() time to propagate
  // before we read game.user.targets.
  setTimeout(() => {
    releaseAllHeldSpellCards();
    reinjectSaveTraysForCurrentTargets();
  }, 50);
  // Broadcast to other clients (GM etc.) to re-inject their save trays.
  game.socket.emit(SOCK, {
    action: "reinjectSaveTrays",
    userId: game.user.id,
  });

  // Store expiry info on the template so the combatTurn hook can delete it.
  // placedRound + placedTurn identifies whose turn it is now; durationRounds
  // tells us how many full turns of that combatant must pass before deletion.
  if (game.combat?.started) {
    const combat      = game.combat;
    // Store the combatant's ID (stable) rather than their turn index
    // (fragile — changes if combatants are added/removed mid-combat)
    const currentCombatant = combat.turns[combat.turn];
    const expiryData  = {
      placedRound:      combat.round,
      placedTurn:       combat.turn,       // kept for legacy fallback
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
//
// Two entry points:
//   A) Spell/item chat cards that have a saving throw: inject a save tray
//      below the card showing each currently-targeted token with a save button.
//   B) The AoE template placement dialog: after targets are confirmed, if the
//      originating spell has a save, show a follow-up save tray chat message.
//
// The PF2e save API:
//   actor.saves["reflex" | "fortitude" | "will"].roll({ dc: { value: N }, origin })
//
// DC and save type are read from the chat message flags:
//   flags.pf2e.context?.dc?.value          — the DC number
//   flags.pf2e.context?.saveType           — "reflex" | "fortitude" | "will"
//   flags.pf2e.strike?.altUsage            — not relevant for saves
//   flags.pf2e.casting?.dc?.value          — alternate DC path for spells
//   flags.pf2e.origin?.actor              — UUID of the casting actor

const SAVE_LABELS = {
  fortitude: "Fortitude",
  reflex:    "Reflex",
  will:      "Will",
};

/**
 * Extract save info from a pf2e chat message's flags.
 * Returns { saveType, dc } or null if this message has no save.
 *
 * Based on real flag structure observed in play:
 *  - saveType lives in origin.rollOptions as "origin:item:defense:<type>"
 *  - DC is not stored in flags; we read it from the origin actor's spellcasting DC
 *    or class DC at runtime.
 *  - Fallback paths included for older/alternate message shapes.
 */
function getSaveInfoFromMessage(message) {
  const pf2e = message.flags?.pf2e;
  if (!pf2e) return null;

  // ── Save type ────────────────────────────────────────────────────────────
  let saveType = null;
  const rollOptions = pf2e.origin?.rollOptions ?? pf2e.context?.options ?? [];
  for (const opt of rollOptions) {
    const m = opt.match(/^(?:origin:)?item:defense:(fortitude|reflex|will)$/);
    if (m) { saveType = m[1]; break; }
  }
  if (!saveType) {
    saveType = pf2e.context?.saveType ?? pf2e.strike?.saveType ?? null;
  }
  if (!saveType || !SAVE_LABELS[saveType]) return null;

  // ── DC ───────────────────────────────────────────────────────────────────
  let dc = null;

  // 1. Try flag paths directly on the message
  dc = pf2e.context?.dc?.value ?? pf2e.casting?.dc?.value ?? null;
  if (dc != null) {
    console.log(`${MODULE_ID} | DC from message flags: ${dc}`);
    return { saveType, dc };
  }

  // 2. Resolve from the origin item (the spell itself)
  if (pf2e.origin?.uuid) {
    try {
      const item = fromUuidSync(pf2e.origin.uuid);
      console.log(`${MODULE_ID} | origin item:`, item);
      if (item) {
        // PF2e spell items expose their DC via the spellcasting entry statistic
        const itemDC =
          item.spellcasting?.statistic?.dc?.value ??          // via entry
          item.parent?.spellcasting?.find?.(e => e.id === pf2e.casting?.id)?.statistic?.dc?.value ??
          null;
        console.log(`${MODULE_ID} | DC from item spellcasting: ${itemDC}`);
        if (itemDC) { dc = itemDC; }
      }
    } catch (e) { console.warn(`${MODULE_ID} | item lookup failed`, e); }
  }

  // 3. Resolve from the origin actor's spellcasting entries
  if (dc == null && pf2e.origin?.actor) {
    try {
      const originActor = fromUuidSync(pf2e.origin.actor);
      console.log(`${MODULE_ID} | origin actor:`, originActor);
      if (originActor) {
        // Log all spellcasting entries so we can see what's available
        const entries = originActor.spellcasting?.contents ?? [];
        console.log(`${MODULE_ID} | spellcasting entries:`, entries.map(e => ({
          id: e.id,
          name: e.name,
          dcValue: e.statistic?.dc?.value,
        })));

        // Try to match the casting entry id from flags
        const castingId = pf2e.casting?.id;
        const matchedEntry = castingId
          ? entries.find(e => e.id === castingId)
          : entries[0];

        const entryDC = matchedEntry?.statistic?.dc?.value ?? null;
        console.log(`${MODULE_ID} | DC from matched entry (id:${castingId}): ${entryDC}`);

        if (entryDC) {
          dc = entryDC;
        } else {
          // Last resort: any numeric dc we can find on the actor
          const fallback =
            originActor.classDC?.value ??
            originActor.system?.attributes?.classOrSpellDC?.value ??
            originActor.system?.attributes?.spellDC?.value ??
            null;
          console.log(`${MODULE_ID} | DC fallback: ${fallback}`);
          dc = fallback;
        }
      }
    } catch (e) { console.warn(`${MODULE_ID} | actor lookup failed`, e); }
  }

  console.log(`${MODULE_ID} | Final saveType:${saveType} dc:${dc}`);
  return { saveType, dc };
}

/**
 * Roll a saving throw for a single token actor.
 * Owned tokens roll on their owner's client; enemy tokens need the GM.
 *
 * @param {string} tokenUuid  UUID of the TokenDocument
 * @param {string} saveType   "reflex" | "fortitude" | "will"
 * @param {number|null} dc    The DC value, or null for no DC display
 * @param {string|null} originActorUuid  UUID of the casting actor for origin context
 */
async function rollSaveForToken(tokenUuid, saveType, dc, originActorUuid) {
  const tokenDoc = fromUuidSync(tokenUuid);
  const actor    = tokenDoc?.actor;
  if (!actor) {
    ui.notifications.warn(`${MODULE_ID}: Could not find actor for save.`);
    return;
  }

  const saveStatistic = actor.saves?.[saveType];
  if (!saveStatistic) {
    ui.notifications.warn(`${MODULE_ID}: ${actor.name} has no ${saveType} save.`);
    return;
  }

  // Build roll options
  const rollOptions = {};
  if (dc != null) {
    rollOptions.dc = { value: Number(dc) };
  }

  // Try to pass origin actor for proper roll-option context
  if (originActorUuid) {
    try {
      const originDoc = fromUuidSync(originActorUuid);
      if (originDoc?.actor ?? originDoc) {
        rollOptions.origin = originDoc?.actor ?? originDoc;
      }
    } catch { /* ignore */ }
  }

  await saveStatistic.roll(rollOptions);
}

/**
 * Build the HTML for a save tray to inject into a chat card or post as a message.
 * Shows one row per target with a save button.
 *
 * @param {string[]} tokenUuids
 * @param {string}   saveType
 * @param {number|null} dc
 * @param {string}   messageId   The source chat message id (for socket relay)
 * @returns {jQuery}
 */
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
      // Ask the GM to roll on behalf of this token
      game.socket.emit(SOCK, {
        action:          "rollSaveForTarget",
        tokenUuid:       uuid,
        saveType,
        dc:              dcVal,
        originActorUuid: origin || null,
        userId:          game.user.id,
      });
    }
  });

  return tray;
}

// ── 4A: Inject save tray into spell/item chat cards ─────────────────────────

/**
 * Shared handler for spell card save tray injection.
 * Called from both renderChatMessage (v11-v13) and renderChatMessageHTML (v14+).
 * @param {ChatMessage} message
 * @param {jQuery} html - jQuery-wrapped element
 */
function injectSaveTray(message, html) {
  // Feature 2 damage tray is handled in injectDamageTray above.
  // Here we handle spell card save trays.
  const isSpellSave = isSpellCardWithSave(message);
  console.log(`${MODULE_ID} | renderChatMessage — isSpellSave:${isSpellSave} msgId:${message.id}`);
  if (!isSpellSave) return;

  const saveInfo = getSaveInfoFromMessage(message);
  console.log(`${MODULE_ID} | saveInfo:`, saveInfo);
  if (!saveInfo) return;

  // Read the caster's current live targets directly.
  // PF2e spell-cast messages are created server-side before any target
  // stamping can happen, so we always use the live targeting state.
  // The AoE picker (Feature 3) sets targets before the spell card renders,
  // so targets will be populated here when casting from the sheet.
  const authorId  = message.author?.id ?? message.user?.id;
  const author    = game.users.get(authorId);
  const liveUuids = [...(author?.targets ?? [])].map(t => t.document?.uuid).filter(Boolean);

  // Also check stored flags as fallback for history re-renders
  const storedUuids = message.flags?.[MODULE_ID]?.targetUuids ?? [];
  const uuids = liveUuids.length ? liveUuids : storedUuids;

  console.log(`${MODULE_ID} | save tray — live:${liveUuids.length} stored:${storedUuids.length} using:${uuids.length}`);

  if (!uuids.length) {
    console.log(`${MODULE_ID} | No targets found.`);
    // Feature 6: If this card was just posted by the local user and has a save,
    // a template / picker is likely on the way.  Hide the card now; we'll show
    // it with a fully-populated save tray once the picker resolves.
    const isRecent = (Date.now() - (message.timestamp ?? 0)) < 5000;
    const isAuthor = (message.author?.id ?? message.user?.id) === game.user.id;
    if (isRecent && isAuthor) {
      _hideSpellCard(message.id);
      setTimeout(() => {
        if (pendingSpellCards.has(message.id)) _releaseSpellCard(message.id);
      }, SPELL_CARD_HOLD_MS);
    }
    return;
  }

  const originUuid = message.flags?.pf2e?.origin?.actor ?? null;

  const tray = buildSaveTray(
    uuids,
    saveInfo.saveType,
    saveInfo.dc,
    message.id,
    originUuid,
  );

  if (tray.length) {
    html.find(".message-content").append(tray);
    console.log(`${MODULE_ID} | Save tray injected for ${uuids.length} target(s).`);
  }
}

// Foundry v11–v13: html is a jQuery object
Hooks.on("renderChatMessage", (message, html) => {
  injectSaveTray(message, html);
});
// Foundry v14+: renderChatMessage is deprecated; html is now a plain HTMLElement
Hooks.on("renderChatMessageHTML", (message, html) => {
  injectSaveTray(message, $(html));
});

// ============================================================
// Feature 5 — Save-Result → Damage Tray Highlighting
// ============================================================

/**
 * Return true if this message is a PF2e saving throw result.
 */
function isSaveResultMessage(message) {
  return message.flags?.pf2e?.context?.type === "saving-throw"
      && message.flags?.pf2e?.context?.outcome != null;
}

/**
 * Extract { tokenUuid, outcome } from a PF2e save result message.
 */
function getSaveResultInfo(message) {
  const ctx = message.flags?.pf2e?.context;
  if (!ctx) return null;
  const outcome   = ctx.outcome;         // criticalSuccess | success | failure | criticalFailure
  const tokenUuid = ctx.token?.uuid ?? null;
  if (!outcome || !tokenUuid) return null;
  return { tokenUuid, outcome };
}

/**
 * Apply (or clear) damage-tray button highlights for a single token
 * based on the most recent save outcome.
 *
 * @param {string}      tokenUuid
 * @param {string|null} outcome — null to clear all highlights
 */
function applyDamageTrayHighlight(tokenUuid, outcome) {
  const suggestedAction = outcome != null ? BASIC_SAVE_DAMAGE_MAP[outcome] : undefined;
  const escapedUuid     = CSS.escape(tokenUuid);

  for (const tray of document.querySelectorAll(".ctote-target-tray")) {
    const row = tray.querySelector(`.ctote-target-row[data-uuid="${escapedUuid}"]`);
    if (!row) continue;

    // Clear previous Feature 5 classes
    row.querySelectorAll(".ctote-btn").forEach(btn => {
      btn.classList.remove("ctote-save-suggested", "ctote-save-dimmed");
    });

    if (outcome == null) continue; // just clearing

    if (suggestedAction === null) {
      // Critical success: 0 damage — dim all damage buttons
      row.querySelectorAll(".ctote-btn-half, .ctote-btn-full, .ctote-btn-double")
         .forEach(btn => btn.classList.add("ctote-save-dimmed"));
    } else {
      // Highlight the matching button
      const btnClass = {
        half:   ".ctote-btn-half",
        full:   ".ctote-btn-full",
        double: ".ctote-btn-double",
      }[suggestedAction];
      if (btnClass) row.querySelector(btnClass)?.classList.add("ctote-save-suggested");
    }
  }
}

/**
 * Hook: fires when a new chat message arrives.
 * We look for PF2e save results and update the damage tray highlights.
 */
Hooks.on("createChatMessage", (message) => {
  if (!isSaveResultMessage(message)) return;
  const info = getSaveResultInfo(message);
  if (!info) return;

  const { tokenUuid, outcome } = info;

  // Cache for 5 minutes — future damage rolls can read this to highlight
  saveResultCache.set(tokenUuid, { outcome, expiresAt: Date.now() + SAVE_RESULT_TTL });

  // Apply immediately to any currently-rendered damage trays
  applyDamageTrayHighlight(tokenUuid, outcome);
});
