import {
  COACH_COLUMNS,
  MAX_TOOLS_PER_EXERCISE,
  applyBulkEdit,
  applySpreadsheetPaste,
  buildClientPrototype,
  buildCoachPrototype,
  canonicalizeCatalogValue,
  canonicalizeCatalogValues,
  catalogPickerOptions,
  coachValuesEqual,
  copyCoachRectangle,
  duplicateExercise,
  duplicateSession,
  groupedCatalogPickerOptions,
  insertExercisesInEmptySession,
  insertSeriesAtSelection,
  normalizeCoachValue,
  formatRestDuration,
  parseRepetitionTarget,
  parseRestDuration,
  parseSpreadsheetPaste,
  pasteCoachRectangle,
  rectangularCellIds,
  removeExercise,
  removeSeries,
  restoreClientPrototype,
  saveClientSet,
  serializeClientPrototype,
  timingResult,
  updateCoachCell,
  upgradeCoachDraftModel,
  validateCatalogMuscleGroups
} from "./prototype-state.mjs?v=20260811.5";

const FIXTURE_URL = "../../sample-data/jbm-alpha.fixture.json";
const PRESCRIPTION_CATALOG_URL = "../../sample-data/jbm-initial-prescription-catalog.json";
const CLIENT_STORAGE_KEY = "jbm:j1:jbm-alpha-v1:client-state-v1";
const COACH_STORAGE_KEY = "jbm:j1:jbm-alpha-v1:coach-draft-v1";
const COACH_MIGRATION_BACKUP_KEY = `${COACH_STORAGE_KEY}:migration-backup`;
const COACH_STORAGE_SCHEMA_VERSION = 2;
const LEGACY_COACH_STORAGE_SCHEMA_VERSION = 1;
const COACH_CLIPBOARD_MIME = "application/x-jbm-coach-rectangle";
const PASTE_EXAMPLE = [
  "C\tROWING (GD)\tPOULIE ; BARRE POULIE\t1\t10-12\t1,5\t2-0-2-0\t90\tRest Pause",
  "C\tROWING (GD)\tPOULIE ; BARRE POULIE\t2\t10-12\t0\t2-0-2-0\t90\t",
  "D\tExercice invalide\tBARRE\t1\t8-10\t1,3\t3-1-1-0\t120\tDrop set"
].join("\n");

const byId = (id) => document.getElementById(id);
const clone = (value) => JSON.parse(JSON.stringify(value));
const displayValue = (value) => value === null || value === undefined ? "" : String(value).replace(".", ",");
const displayCoachValue = (field, value) => {
  if (field === "tools" && Array.isArray(value)) return value.join(" ; ");
  if (field === "restSeconds" && value !== null && value !== undefined && value !== "") {
    return formatRestDuration(value);
  }
  return displayValue(value);
};
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

let fixture;
let prescriptionCatalog;
let coachModel;
let clientModel;
let undoStack = [];
let redoStack = [];
let selection = { anchor: null, focus: null };
let coachClipboard = null;
let pastePreview = null;
let exercisePickerContext = null;
let exerciseBuilderContext = null;
let toolPickerContext = null;
let prescriptionPickerContext = null;
let activeMobileScreen = "today";
let timingTrial = null;
let lastTimingResult = null;
let clientDrafts = {};
let coachDraftRestored = false;
let coachDraftRestoreWarning = null;
let coachDraftMigrationOverflow = [];
let coachDraftMigrationRepairs = [];
let coachDraftExactBackupCreated = false;
let restInterval = null;
let toastTimeout = null;
let coachGridRefreshTimeout = null;
let programmaticCoachFocusCellId = null;
let coachPointerSelection = null;
let suppressCoachGridClick = false;

const showToast = (message) => {
  const toast = byId("toast");
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => {
    toast.hidden = true;
  }, 3200);
};

const setCoachActivity = (message) => {
  byId("coach-activity").textContent = message;
};

const settlePrototypeLoading = (state) => {
  const root = document.documentElement;
  const timers = Array.isArray(window.__j1PrototypeLoadTimers)
    ? window.__j1PrototypeLoadTimers
    : [];
  timers.forEach((timer) => window.clearTimeout(timer));
  window.__j1PrototypeLoadTimers = [];
  root.dataset.prototypeLoadState = state;
  if (state === "ready") {
    root.dataset.prototypeReady = "true";
    delete root.dataset.prototypeLoadFailed;
  } else if (state === "failed") {
    root.dataset.prototypeLoadFailed = "true";
    delete root.dataset.prototypeReady;
  }
  const retryButton = byId("retry-prototype-load");
  if (retryButton) retryButton.hidden = true;
};

const readClientStorage = () => {
  try {
    return window.localStorage.getItem(CLIENT_STORAGE_KEY);
  } catch {
    return null;
  }
};

const persistClient = (candidate = clientModel) => {
  try {
    window.localStorage.setItem(CLIENT_STORAGE_KEY, serializeClientPrototype(candidate));
    return true;
  } catch {
    showToast("Le navigateur refuse la sauvegarde locale.");
    return false;
  }
};

const coachRowHasValidValues = (row) => {
  try {
    return COACH_COLUMNS.every((column) => coachValuesEqual(
      normalizeCoachValue(column.key, row[column.key]),
      row[column.key]
    ));
  } catch {
    return false;
  }
};

const isValidCoachModel = (candidate, fresh) => {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  if (candidate.fixtureId !== fresh.fixtureId
    || candidate.programName !== fresh.programName
    || candidate.versionLabel !== fresh.versionLabel
    || !Array.isArray(candidate.sessions)
    || candidate.sessions.length === 0
    || candidate.sessions.length > 100) return false;

  const sessionIds = new Set();
  const rowIds = new Set();
  const plannedSetIds = new Set();
  for (const session of candidate.sessions) {
    if (!session || typeof session !== "object"
      || typeof session.id !== "string"
      || typeof session.name !== "string"
      || sessionIds.has(session.id)
      || !Array.isArray(session.rows)
      || session.rows.length > 5000) return false;
    sessionIds.add(session.id);
    for (const row of session.rows) {
      if (!row || typeof row !== "object"
        || typeof row.id !== "string"
        || typeof row.plannedSetId !== "string"
        || typeof row.plannedExerciseId !== "string"
        || typeof row.groupId !== "string"
        || !["simple", "superset"].includes(row.groupType)
        || !Array.isArray(row.tools)
        || row.tools.length > MAX_TOOLS_PER_EXERCISE
        || row.tools.some((tool) => typeof tool !== "string" || tool.trim().length === 0)
        || new Set(row.tools.map((tool) => tool.normalize("NFC").toLocaleUpperCase("fr-FR"))).size !== row.tools.length
        || typeof row.technique !== "string"
        || rowIds.has(row.id)
        || plannedSetIds.has(row.plannedSetId)
        || COACH_COLUMNS.some((column) => !Object.hasOwn(row, column.key))
        || !coachRowHasValidValues(row)) return false;
      rowIds.add(row.id);
      plannedSetIds.add(row.plannedSetId);
    }
  }
  return typeof candidate.selectedSessionId === "string" && sessionIds.has(candidate.selectedSessionId);
};

const validMigrationOverflow = (entries) => Array.isArray(entries)
  ? entries.filter((entry) => entry
    && typeof entry.sessionId === "string"
    && typeof entry.rowId === "string"
    && Array.isArray(entry.tools)
    && entry.tools.length > 0
    && entry.tools.every((tool) => typeof tool === "string" && tool.trim().length > 0)
  ).slice(0, 5000).map(clone)
  : [];

const migrationOverflowCount = (entries) => entries
  .reduce((count, entry) => count + entry.tools.length, 0);

const validMigrationRepairs = (entries) => Array.isArray(entries)
  ? entries.filter((entry) => entry
    && typeof entry.sessionId === "string"
    && typeof entry.plannedExerciseId === "string"
    && Array.isArray(entry.reasons)
    && entry.reasons.every((reason) => ["tools", "tempo", "restSeconds", "setRank"].includes(reason))
    && Array.isArray(entry.rows)
    && entry.rows.length > 0
      && entry.rows.every((row) => row
      && typeof row.rowId === "string"
      && Array.isArray(row.tools)
      && row.tools.every((tool) => typeof tool === "string")
      && (["string", "number"].includes(typeof row.setRank) || row.setRank === null)
      && typeof row.tempo === "string"
      && Number.isInteger(row.restSeconds)
    )
  ).slice(0, 5000).map(clone)
  : [];

const restoreCoachDraft = (sourceFixture) => {
  const fresh = buildCoachPrototype(sourceFixture);
  try {
    const serialized = window.localStorage.getItem(COACH_STORAGE_KEY);
    if (!serialized) return fresh;
    const envelope = JSON.parse(serialized);
    if (![LEGACY_COACH_STORAGE_SCHEMA_VERSION, COACH_STORAGE_SCHEMA_VERSION].includes(envelope?.schemaVersion)
      || envelope.fixtureId !== fresh.fixtureId) return fresh;
    const upgraded = upgradeCoachDraftModel(
      envelope.model,
      envelope.schemaVersion === LEGACY_COACH_STORAGE_SCHEMA_VERSION
    );
    if (!isValidCoachModel(upgraded.model, fresh)) return fresh;
    coachDraftMigrationOverflow = [
      ...validMigrationOverflow(envelope.migrationOverflow),
      ...upgraded.overflowTools
    ];
    coachDraftMigrationRepairs = [
      ...validMigrationRepairs(envelope.migrationRepairs),
      ...upgraded.legacyRepairs
    ];
    const overflowCount = migrationOverflowCount(coachDraftMigrationOverflow);
    const repairedExerciseCount = coachDraftMigrationRepairs.length;
    if (overflowCount > 0 || repairedExerciseCount > 0) {
      let exactBackupCreated = false;
      if (upgraded.overflowTools.length > 0 || upgraded.legacyRepairs.length > 0) {
        try {
          window.localStorage.setItem(COACH_MIGRATION_BACKUP_KEY, serialized);
          exactBackupCreated = true;
          coachDraftExactBackupCreated = true;
        } catch {
          // Les valeurs excédentaires restent aussi dans l'enveloppe active, associées à leur ligne.
        }
      }
      const details = [
        overflowCount > 0 ? `${overflowCount} outil(s) au-delà de la limite de 6` : null,
        repairedExerciseCount > 0 ? `${repairedExerciseCount} exercice(s) ancien(s) remis en cohérence` : null
      ].filter(Boolean).join(" et ");
      coachDraftRestoreWarning = exactBackupCreated
        ? `${details} ; les valeurs sources restent dans une sauvegarde locale exacte et dans le brouillon migré.`
        : `${details} ; les valeurs sources restent conservées dans le brouillon migré.`;
    }
    coachDraftRestored = true;
    return upgraded.model;
  } catch {
    return fresh;
  }
};

const persistCoach = (candidate = coachModel) => {
  try {
    const envelope = {
      schemaVersion: COACH_STORAGE_SCHEMA_VERSION,
      fixtureId: candidate.fixtureId,
      savedAt: new Date().toISOString(),
      model: candidate
    };
    if (coachDraftMigrationOverflow.length > 0) {
      envelope.migrationOverflow = clone(coachDraftMigrationOverflow);
    }
    if (coachDraftMigrationRepairs.length > 0) {
      envelope.migrationRepairs = clone(coachDraftMigrationRepairs);
    }
    window.localStorage.setItem(COACH_STORAGE_KEY, JSON.stringify(envelope));
    return true;
  } catch {
    showToast("Le navigateur refuse la sauvegarde du brouillon coach.");
    return false;
  }
};

const selectedSession = () => coachModel.sessions.find((session) => session.id === coachModel.selectedSessionId);

const ensureSelection = () => {
  const session = selectedSession();
  if (!session?.rows.length) {
    selection = { anchor: null, focus: null };
    return;
  }
  const valid = (cell) => cell
    && session.rows.some((row) => row.id === cell.rowId)
    && COACH_COLUMNS.some((column) => column.key === cell.columnKey);
  if (!valid(selection.anchor) || !valid(selection.focus)) {
    const first = { rowId: session.rows[0].id, columnKey: "exerciseName" };
    selection = { anchor: first, focus: first };
  }
};

const selectedCellIds = () => {
  ensureSelection();
  if (!selection.anchor || !selection.focus) return [];
  return rectangularCellIds(selectedSession().rows, COACH_COLUMNS, selection.anchor, selection.focus);
};

const syncCoachActionState = () => {
  const session = selectedSession();
  const hasRows = (session?.rows.length ?? 0) > 0;
  const hasSelection = hasRows && selectedCellIds().length > 0;
  ["insert-series-before", "insert-series-after"].forEach((id) => {
    const button = byId(id);
    button.removeAttribute("aria-busy");
    button.disabled = !session;
    button.textContent = hasRows
      ? id === "insert-series-before" ? "＋ Avant" : "＋ Après"
      : "＋ Composer";
    if (hasRows) {
      button.removeAttribute("aria-label");
    } else {
      button.setAttribute(
        "aria-label",
        `Composer la séance vierge — commande ${id === "insert-series-before" ? "Avant" : "Après"}`
      );
    }
    button.title = !session
      ? "Sélectionnez d'abord une séance"
      : hasRows
      ? "Ajouter une série par rapport à la série active"
      : "Choisir plusieurs exercices et leurs valeurs par défaut";
  });
  [
    "remove-series",
    "remove-exercise",
    "duplicate-exercise"
  ].forEach((id) => { byId(id).disabled = !hasRows; });
  ["bulk-field", "bulk-value", "apply-bulk-edit"].forEach((id) => {
    byId(id).disabled = !hasRows;
  });
  byId("copy-selection").disabled = !hasSelection;
  byId("paste-selection").disabled = !hasSelection || !coachClipboard;
  byId("clipboard-summary").textContent = coachClipboard
    ? `Copie interne : ${coachClipboard.rowCount} × ${coachClipboard.columnCount}`
    : "Aucune copie interne";
};

const repaintCoachSelection = () => {
  const selected = new Set(selectedCellIds());
  document.querySelectorAll(".grid-cell").forEach((cell) => {
    const isSelected = selected.has(cell.dataset.cellId);
    const isAnchor = selection.anchor?.rowId === cell.dataset.rowId
      && selection.anchor?.columnKey === cell.dataset.columnKey;
    cell.classList.toggle("is-selected", isSelected);
    cell.classList.toggle("is-anchor", isAnchor);
    cell.setAttribute("aria-selected", String(isSelected));
  });
  byId("selection-count").textContent = selected.size;
  syncCoachActionState();
};

const renderCoachHead = () => {
  byId("coach-grid-head").innerHTML = `<tr role="row">${COACH_COLUMNS.map((column) => (
    `<th scope="col" role="columnheader">${escapeHtml(column.label)}</th>`
  )).join("")}</tr>`;
};

const renderPrescriptionDatalists = () => {
  const renderOptions = (values) => values
    .map((value) => `<option value="${escapeHtml(value)}"></option>`)
    .join("");
  byId("exercise-options").innerHTML = renderOptions(prescriptionCatalog.exercises);
  byId("tool-options").innerHTML = renderOptions(prescriptionCatalog.tools);
  byId("repetition-target-options").innerHTML = renderOptions(prescriptionCatalog.repetitionTargets);
  byId("rest-preset-options").innerHTML = renderOptions(
    prescriptionCatalog.restPresets.map((preset) => preset.label)
  );
  byId("technique-options").innerHTML = renderOptions(prescriptionCatalog.techniques);
  const exerciseSearchLabel = `Rechercher dans les ${prescriptionCatalog.exercises.length} exercices configurés`;
  byId("exercise-picker-search-label").textContent = exerciseSearchLabel;
  byId("exercise-builder-search-label").textContent = exerciseSearchLabel;
  byId("exercise-builder-repetitions").innerHTML = prescriptionCatalog.repetitionTargets
    .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
    .join("");
  byId("exercise-builder-rir").innerHTML = Array.from({ length: 21 }, (_, index) => index / 2)
    .map((value) => `<option value="${value}">${displayValue(value)}</option>`)
    .join("");
};

const catalogPickerPresentation = (field, row) => ({
  exerciseName: {
    label: `Choisir un exercice connu, ${row.exerciseName}, série ${row.setRank}`,
    title: "Choisir un exercice dans le catalogue"
  },
  tools: {
    label: `Choisir les outils, ${row.exerciseName}, série ${row.setRank}`,
    title: "Choisir jusqu’à 6 outils dans le catalogue"
  },
  targetReps: {
    label: `Choisir une cible de répétitions, ${row.exerciseName}, série ${row.setRank}`,
    title: "Choisir une cible de répétitions ou de durée"
  },
  restSeconds: {
    label: `Choisir le repos, ${row.exerciseName}, série ${row.setRank}`,
    title: "Choisir une durée de repos"
  },
  technique: {
    label: `Choisir la technique, ${row.exerciseName}, série ${row.setRank}`,
    title: "Choisir une technique ou aucune"
  }
})[field] ?? null;

const renderCoachGrid = (focusCellId = null) => {
  const startedAt = performance.now();
  const session = selectedSession();
  ensureSelection();
  const selected = new Set(selectedCellIds());
  const previousGroupByIndex = session.rows.map((row, index) => index > 0 ? session.rows[index - 1].groupId : null);

  byId("coach-grid-body").innerHTML = session.rows.length === 0
    ? `<tr class="grid-empty" role="row">
      <td class="grid-empty-message" role="gridcell" colspan="${COACH_COLUMNS.length}">
        <div class="grid-empty-content">
          <strong>Cette séance est vierge</strong>
          <p>Choisissez un ou plusieurs exercices par groupe musculaire, ou collez des lignes depuis Sheets.</p>
          <button id="add-first-exercise" class="button button-primary" type="button">
            ＋ Composer la séance
          </button>
        </div>
      </td>
    </tr>`
    : session.rows.map((row, rowIndex) => {
    const groupStart = rowIndex === 0 || previousGroupByIndex[rowIndex] !== row.groupId;
    return `<tr role="row" class="${groupStart ? "group-start" : ""}" data-row-id="${escapeHtml(row.id)}">${COACH_COLUMNS.map((column) => {
      const cellId = `${row.id}::${column.key}`;
      const isSelected = selected.has(cellId);
      const isAnchor = selection.anchor?.rowId === row.id && selection.anchor?.columnKey === column.key;
      const inputMode = column.key === "setRank" ? "numeric"
        : column.key === "targetRir" ? "decimal" : "text";
      const structuralAttributes = column.key === "setRank"
        ? ' readonly aria-readonly="true" title="Calculé d’après l’ordre des séries"'
        : "";
      const listId = {
        tools: "tool-options",
        targetReps: "repetition-target-options",
        restSeconds: "rest-preset-options",
        technique: "technique-options"
      }[column.key];
      const listAttribute = listId ? ` list="${listId}"` : "";
      const guidanceAttributes = column.key === "tools"
        ? ` placeholder="OUTIL 1 ; OUTIL 2" title="Séparez jusqu’à ${MAX_TOOLS_PER_EXERCISE} outils par un point-virgule"`
        : column.key === "targetReps"
          ? ' placeholder="8-10, MAX ou 0’45" title="Nombre, plage de répétitions, MAX ou durée"'
          : column.key === "restSeconds"
            ? ' placeholder="1’30" title="Durée lisible ou nombre historique de secondes"'
        : column.key === "technique"
          ? ' placeholder="Facultative" title="Une technique maximum ; laissez vide si aucune"'
          : "";
      const inputHtml = `<input value="${escapeHtml(displayCoachValue(column.key, row[column.key]))}" inputmode="${inputMode}"${listAttribute}${guidanceAttributes}
        aria-label="${escapeHtml(`${column.label}, ${row.exerciseName}, série ${row.setRank}`)}"
        data-row-id="${escapeHtml(row.id)}" data-column-key="${escapeHtml(column.key)}"${structuralAttributes}>`;
      const picker = catalogPickerPresentation(column.key, row);
      const editorHtml = picker
        ? `<div class="catalog-cell-editor">${inputHtml}<button class="catalog-picker-button" type="button"
            aria-label="${escapeHtml(picker.label)}" aria-haspopup="dialog"
            data-catalog-picker-field="${escapeHtml(column.key)}"
            data-catalog-picker-row-id="${escapeHtml(row.id)}" title="${escapeHtml(picker.title)}">⌄</button></div>`
        : inputHtml;
      return `<td role="gridcell" class="grid-cell ${isSelected ? "is-selected" : ""} ${isAnchor ? "is-anchor" : ""}"
        data-cell-id="${escapeHtml(cellId)}" data-row-id="${escapeHtml(row.id)}"
        data-column-key="${escapeHtml(column.key)}" aria-selected="${isSelected}">
        ${editorHtml}
      </td>`;
    }).join("")}</tr>`;
  }).join("");

  byId("add-first-exercise")?.addEventListener("click", openExerciseBuilder);
  bindCoachGridEvents();
  byId("row-count").textContent = session.rows.length;
  byId("selection-count").textContent = selected.size;
  document.querySelector(".coach-grid").setAttribute("aria-rowcount", String(session.rows.length + 1));
  byId("render-duration").textContent = `${(performance.now() - startedAt).toFixed(1)} ms`;
  syncCoachActionState();

  if (focusCellId) {
    programmaticCoachFocusCellId = focusCellId;
    requestAnimationFrame(() => {
      const input = document.querySelector(`[data-cell-id="${CSS.escape(focusCellId)}"] input`);
      input?.focus({ preventScroll: true });
      if (programmaticCoachFocusCellId === focusCellId) programmaticCoachFocusCellId = null;
    });
  }
};

const renderSessionList = () => {
  byId("session-list").innerHTML = coachModel.sessions.map((session, index) => `
    <button class="session-item ${session.id === coachModel.selectedSessionId ? "active" : ""}"
      type="button" role="listitem" data-session-id="${escapeHtml(session.id)}">
      <span class="session-order">${String(index + 1).padStart(2, "0")}</span>
      <span><strong>${escapeHtml(session.name)}</strong><small>${session.rows.length} séries</small></span>
    </button>
  `).join("");
  document.querySelectorAll("[data-session-id]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!prepareCoachCommand()) return;
      const next = clone(coachModel);
      next.selectedSessionId = button.dataset.sessionId;
      if (!persistCoach(next)) {
        setCoachActivity("Séance non ouverte : le brouillon n'a pas pu être sauvegardé.");
        return;
      }
      coachModel = next;
      selection = { anchor: null, focus: null };
      renderCoach();
      setCoachActivity(`Séance « ${selectedSession().name} » ouverte.`);
    });
  });
};

const renderCoach = (focusCellId = null) => {
  renderCoachHead();
  renderSessionList();
  const session = selectedSession();
  byId("coach-title").textContent = coachModel.programName;
  byId("coach-version").textContent = `${coachModel.versionLabel} publiée · copie locale de travail`;
  byId("selected-session-name").textContent = session.name;
  byId("session-count").textContent = coachModel.sessions.length;
  byId("undo-action").disabled = undoStack.length === 0;
  byId("redo-action").disabled = redoStack.length === 0;
  byId("undo-depth").textContent = undoStack.length;
  renderCoachGrid(focusCellId);
};

const commitCoachModel = (nextModel, message, focusCellId = null) => {
  window.clearTimeout(coachGridRefreshTimeout);
  if (!persistCoach(nextModel)) {
    ensureSelection();
    repaintCoachSelection();
    setCoachActivity("Action non appliquée : le brouillon local n'a pas pu être sauvegardé.");
    return false;
  }
  undoStack.push(clone(coachModel));
  redoStack = [];
  coachModel = nextModel;
  byId("undo-action").disabled = undoStack.length === 0;
  byId("redo-action").disabled = redoStack.length === 0;
  byId("undo-depth").textContent = undoStack.length;
  if (focusCellId !== false) renderCoach(focusCellId);
  setCoachActivity(message);
  return true;
};

const moveGridFocus = (rowId, columnKey, key, shiftKey, extendSelection) => {
  const rows = selectedSession().rows;
  const rowIndex = rows.findIndex((row) => row.id === rowId);
  const columnIndex = COACH_COLUMNS.findIndex((column) => column.key === columnKey);
  let nextRowIndex = rowIndex;
  let nextColumnIndex = columnIndex;
  if (key === "Tab") {
    const cellCount = rows.length * COACH_COLUMNS.length;
    const currentIndex = rowIndex * COACH_COLUMNS.length + columnIndex;
    const nextIndex = Math.max(0, Math.min(cellCount - 1, currentIndex + (shiftKey ? -1 : 1)));
    nextRowIndex = Math.floor(nextIndex / COACH_COLUMNS.length);
    nextColumnIndex = nextIndex % COACH_COLUMNS.length;
  } else if (key === "Enter") {
    nextRowIndex = Math.max(0, Math.min(rows.length - 1, rowIndex + (shiftKey ? -1 : 1)));
  } else if (key === "ArrowUp" || key === "ArrowDown") {
    nextRowIndex = Math.max(0, Math.min(rows.length - 1, rowIndex + (key === "ArrowUp" ? -1 : 1)));
  } else if (key === "ArrowLeft" || key === "ArrowRight") {
    nextColumnIndex = Math.max(0, Math.min(COACH_COLUMNS.length - 1, columnIndex + (key === "ArrowLeft" ? -1 : 1)));
  }
  const nextRow = rows[nextRowIndex];
  const nextColumn = COACH_COLUMNS[nextColumnIndex];
  const nextCell = { rowId: nextRow.id, columnKey: nextColumn.key };
  selection = extendSelection
    ? { anchor: selection.anchor ?? { rowId, columnKey }, focus: nextCell }
    : { anchor: nextCell, focus: nextCell };
  renderCoachGrid(`${nextCell.rowId}::${nextCell.columnKey}`);
};

const commitCoachInput = (input, renderAfterCommit = true) => {
  if (input.readOnly) return true;
  const cellId = `${input.dataset.rowId}::${input.dataset.columnKey}`;
  try {
    const currentRow = selectedSession().rows.find((row) => row.id === input.dataset.rowId);
    const next = updateCoachCell(
      coachModel,
      coachModel.selectedSessionId,
      input.dataset.rowId,
      input.dataset.columnKey,
      input.value
    );
    const nextRow = next.sessions
      .find((session) => session.id === next.selectedSessionId)
      ?.rows.find((row) => row.id === input.dataset.rowId);
    input.setCustomValidity("");
    if (coachValuesEqual(currentRow?.[input.dataset.columnKey], nextRow?.[input.dataset.columnKey])) return true;
    return commitCoachModel(
      next,
      "Cellule modifiée. La version publiée reste intacte.",
      renderAfterCommit ? cellId : false
    );
  } catch (error) {
    input.setCustomValidity(error.message);
    input.reportValidity();
    return false;
  }
};

const activeCoachInput = () => document.activeElement?.matches?.(".grid-cell input")
  ? document.activeElement
  : null;

const coachInputIsDirty = (input) => {
  const row = selectedSession()?.rows.find((candidate) => candidate.id === input.dataset.rowId);
  return Boolean(row) && displayCoachValue(input.dataset.columnKey, row[input.dataset.columnKey]) !== input.value;
};

const dirtyCoachInput = () => {
  if (!selectedSession()) return null;
  return [...document.querySelectorAll(".grid-cell input:not([readonly])")]
    .find(coachInputIsDirty) ?? null;
};

const syncCoachRowAccessibleLabels = (rows) => {
  rows.forEach((row) => {
    COACH_COLUMNS.forEach((column) => {
      const input = document.querySelector(
        `[data-cell-id="${CSS.escape(`${row.id}::${column.key}`)}"] input`
      );
      input?.setAttribute("aria-label", `${column.label}, ${row.exerciseName}, série ${row.setRank}`);
      const picker = catalogPickerPresentation(column.key, row);
      if (!picker) return;
      const button = document.querySelector(
        `[data-catalog-picker-row-id="${CSS.escape(row.id)}"]`
        + `[data-catalog-picker-field="${CSS.escape(column.key)}"]`
      );
      button?.setAttribute("aria-label", picker.label);
    });
  });
};

const syncCoachInputFromModel = (input) => {
  const session = selectedSession();
  const row = session?.rows.find((candidate) => candidate.id === input.dataset.rowId);
  if (!row) return;
  const exerciseLevelFields = new Set(["exerciseName", "tools", "tempo", "restSeconds"]);
  const targetRows = exerciseLevelFields.has(input.dataset.columnKey)
    ? session.rows.filter((candidate) => candidate.plannedExerciseId === row.plannedExerciseId)
    : input.dataset.columnKey === "groupLabel"
      ? session.rows.filter((candidate) => candidate.groupId === row.groupId)
      : [row];
  const valuesByRowId = new Map(targetRows.map((candidate) => [
    candidate.id,
    displayCoachValue(input.dataset.columnKey, candidate[input.dataset.columnKey])
  ]));
  document.querySelectorAll(`.grid-cell input[data-column-key="${input.dataset.columnKey}"]`).forEach((candidate) => {
    if (valuesByRowId.has(candidate.dataset.rowId)) candidate.value = valuesByRowId.get(candidate.dataset.rowId);
  });
  if (input.dataset.columnKey === "exerciseName") syncCoachRowAccessibleLabels(targetRows);
};

const prepareCoachCommand = (input = activeCoachInput()) => {
  const pendingInput = dirtyCoachInput() ?? input;
  if (pendingInput) {
    if (!commitCoachInput(pendingInput, false)) {
      if (!pendingInput.checkValidity()) {
        setCoachActivity("Action interrompue : corrigez d’abord la cellule invalide.");
      }
      return false;
    }
    syncCoachInputFromModel(pendingInput);
  }
  const invalidInput = document.querySelector(".grid-cell input:invalid");
  if (invalidInput) {
    invalidInput.focus({ preventScroll: false });
    invalidInput.reportValidity();
    setCoachActivity("Action interrompue : corrigez d’abord la cellule invalide.");
    return false;
  }
  window.clearTimeout(coachGridRefreshTimeout);
  return true;
};

const coachClipboardTsv = (clipboard) => clipboard.values
  .map((row) => row.map((value, index) => displayCoachValue(clipboard.columnKeys?.[index], value)).join("\t"))
  .join("\n");

const setCoachClipboard = (clipboard) => {
  coachClipboard = {
    ...clone(clipboard),
    tsv: coachClipboardTsv(clipboard)
  };
  syncCoachActionState();
  return coachClipboard;
};

const copyCoachSelection = (input = activeCoachInput()) => {
  if (!prepareCoachCommand(input)) return null;
  ensureSelection();
  if (!selection.anchor || !selection.focus) {
    showToast("Sélectionnez d’abord une cellule à copier.");
    return null;
  }
  try {
    const clipboard = setCoachClipboard(copyCoachRectangle(
      coachModel,
      coachModel.selectedSessionId,
      selection.anchor,
      selection.focus
    ));
    const cellCount = clipboard.rowCount * clipboard.columnCount;
    setCoachActivity(`${cellCount} cellule(s) copiée(s) dans le presse-papiers interne.`);
    return clipboard;
  } catch (error) {
    showToast(error.message);
    setCoachActivity(`Copie refusée : ${error.message}`);
    return null;
  }
};

const focusCoachCell = (cell) => {
  if (!cell) return;
  const cellId = `${cell.rowId}::${cell.columnKey}`;
  programmaticCoachFocusCellId = cellId;
  requestAnimationFrame(() => {
    document.querySelector(`[data-cell-id="${CSS.escape(cellId)}"] input`)
      ?.focus({ preventScroll: true });
    if (programmaticCoachFocusCellId === cellId) programmaticCoachFocusCellId = null;
  });
};

const pasteCoachSelection = (clipboard = coachClipboard, input = activeCoachInput()) => {
  if (!clipboard) {
    showToast("Copiez d’abord un rectangle de cellules dans la grille.");
    return false;
  }
  if (!prepareCoachCommand(input)) return false;
  ensureSelection();
  const target = selection.focus;
  if (!target) {
    showToast("Sélectionnez la cellule où commencer le collage.");
    return false;
  }
  try {
    const result = pasteCoachRectangle(
      coachModel,
      coachModel.selectedSessionId,
      target,
      clipboard
    );
    selection = {
      anchor: result.destinationAnchor,
      focus: result.destinationFocus
    };
    const rectangleRowCount = clipboard.rowCount;
    const propagation = result.changedRowCount > rectangleRowCount
      ? ` Les règles d’exercice ont propagé la modification à ${result.changedRowCount} lignes.`
      : "";
    const structural = result.preservedStructuralCellCount > 0
      ? ` ${result.preservedStructuralCellCount} numéro(s) de série calculé(s) ont été conservé(s).`
      : "";
    const message = result.changedRowCount === 0
      ? `Collage sans changement : les valeurs étaient déjà identiques.${structural}`
      : `${result.pastedCellCount} cellule(s) recopiée(s) en une action annulable.${propagation}${structural}`;
    if (result.changedRowCount === 0) {
      renderCoachGrid(`${result.destinationAnchor.rowId}::${result.destinationAnchor.columnKey}`);
      setCoachActivity(message);
    } else {
      if (!commitCoachModel(
        result.model,
        message,
        `${result.destinationAnchor.rowId}::${result.destinationAnchor.columnKey}`
      )) return false;
    }
    return true;
  } catch (error) {
    showToast(error.message);
    setCoachActivity(`Collage refusé sans modification : ${error.message}`);
    focusCoachCell(target);
    return false;
  }
};

const clipboardTextMatches = (left, right) => String(left).replaceAll("\r\n", "\n")
  === String(right).replaceAll("\r\n", "\n");

const clipboardFromPasteEvent = (event) => {
  const custom = event.clipboardData?.getData(COACH_CLIPBOARD_MIME);
  if (custom) return JSON.parse(custom);
  const plain = event.clipboardData?.getData("text/plain");
  return coachClipboard && clipboardTextMatches(plain, coachClipboard.tsv)
    ? coachClipboard
    : null;
};

const horizontalArrowLeavesInput = (input, key) => {
  const start = input.selectionStart ?? 0;
  const end = input.selectionEnd ?? start;
  if (start !== end) return false;
  return key === "ArrowLeft" ? start === 0 : end === input.value.length;
};

const tabLeavesCoachGrid = (rowId, columnKey, shiftKey) => {
  const rows = selectedSession().rows;
  const rowIndex = rows.findIndex((row) => row.id === rowId);
  const columnIndex = COACH_COLUMNS.findIndex((column) => column.key === columnKey);
  const currentIndex = rowIndex * COACH_COLUMNS.length + columnIndex;
  const lastIndex = rows.length * COACH_COLUMNS.length - 1;
  return shiftKey ? currentIndex === 0 : currentIndex === lastIndex;
};

const CATALOG_PICKER_FIELDS = new Set([
  "exerciseName",
  "tools",
  "targetReps",
  "restSeconds",
  "technique"
]);

const adjacentCoachCell = (rowId, columnKey, offset) => {
  const rows = selectedSession().rows;
  const rowIndex = rows.findIndex((row) => row.id === rowId);
  const columnIndex = COACH_COLUMNS.findIndex((column) => column.key === columnKey);
  if (rowIndex < 0 || columnIndex < 0) return null;
  const nextIndex = rowIndex * COACH_COLUMNS.length + columnIndex + offset;
  if (nextIndex < 0 || nextIndex >= rows.length * COACH_COLUMNS.length) return null;
  return {
    rowId: rows[Math.floor(nextIndex / COACH_COLUMNS.length)].id,
    columnKey: COACH_COLUMNS[nextIndex % COACH_COLUMNS.length].key
  };
};

const focusCatalogPickerButton = ({ rowId, columnKey }) => {
  const button = document.querySelector(
    `[data-catalog-picker-row-id="${CSS.escape(rowId)}"]`
    + `[data-catalog-picker-field="${CSS.escape(columnKey)}"]`
  );
  button?.focus({ preventScroll: true });
  return Boolean(button);
};

const scheduleCoachGridRefresh = () => {
  window.clearTimeout(coachGridRefreshTimeout);
  coachGridRefreshTimeout = window.setTimeout(() => {
    const activeInput = document.activeElement?.matches?.(".grid-cell input")
      ? document.activeElement
      : null;
    const focusCellId = activeInput
      ? `${activeInput.dataset.rowId}::${activeInput.dataset.columnKey}`
      : null;
    renderCoachGrid(focusCellId);
  }, 0);
};

const exerciseMuscleGroups = () => Array.isArray(prescriptionCatalog.muscleGroups)
  && prescriptionCatalog.muscleGroups.length > 0
  ? prescriptionCatalog.muscleGroups
  : [{ name: "EXERCICES", exercises: prescriptionCatalog.exercises }];

const groupedExerciseOptionHtml = (option, inputHtml) => (
  `<label class="tool-picker-option ${option.selected ? "is-selected" : ""} ${option.legacy ? "is-legacy" : ""}">
    ${inputHtml}
    <span><strong>${escapeHtml(option.value)}</strong>${option.legacy ? "<small>Valeur existante hors catalogue</small>" : ""}</span>
  </label>`
);

const groupedExerciseCatalogHtml = (groups, context, mode) => groups.map((group) => {
  const forcedOpen = context.query.trim().length > 0;
  const isOpen = forcedOpen || context.openGroups.has(group.name);
  const options = group.options.map((option) => {
    const inputHtml = mode === "single"
      ? `<input type="radio" name="exercise-picker-choice" value="${escapeHtml(option.value)}" ${option.selected ? "checked" : ""}>`
      : `<input type="checkbox" value="${escapeHtml(option.value)}" ${option.selected ? "checked" : ""}>`;
    return groupedExerciseOptionHtml(option, inputHtml);
  }).join("");
  const allVisibleOptionsSelected = group.options.every((option) => option.selected);
  const groupActionTarget = context.query.trim() ? "ces résultats" : "ce groupe";
  const groupAction = mode === "multiple"
    ? `<button class="muscle-group-select" type="button" data-builder-toggle-group="${escapeHtml(group.name)}">
        ${allVisibleOptionsSelected ? `Retirer ${groupActionTarget}` : `Sélectionner ${groupActionTarget}`}
      </button>`
    : "";
  return `<details class="muscle-group" data-muscle-group="${escapeHtml(group.name)}" ${isOpen ? "open" : ""}>
    <summary>
      <span>${escapeHtml(group.name)}</span>
      <span class="muscle-group-count">${group.options.length} exercice${group.options.length > 1 ? "s" : ""}</span>
    </summary>
    <div class="muscle-group-body">
      ${groupAction}
      <div class="muscle-group-options">${options}</div>
    </div>
  </details>`;
}).join("");

const bindMuscleGroupDisclosures = (container, context) => {
  container.querySelectorAll("details[data-muscle-group]").forEach((details) => {
    details.addEventListener("toggle", () => {
      if (context.query.trim()) return;
      if (details.open) context.openGroups.add(details.dataset.muscleGroup);
      else context.openGroups.delete(details.dataset.muscleGroup);
    });
  });
};

const exercisePickerGroups = (currentValues, query = "") => groupedCatalogPickerOptions(
  exerciseMuscleGroups(),
  currentValues,
  query
);

const setExerciseGroupExpansion = (context, currentValues, expanded, renderer) => {
  const groups = exercisePickerGroups(currentValues, "");
  context.openGroups = new Set(expanded ? groups.map((group) => group.name) : []);
  renderer();
};

const renderExercisePickerOptions = () => {
  if (!exercisePickerContext) return;
  exercisePickerContext.query = byId("exercise-picker-search").value;
  const groups = exercisePickerGroups(
    [exercisePickerContext.value],
    exercisePickerContext.query
  );
  const optionCount = groups.reduce((count, group) => count + group.options.length, 0);
  const container = byId("exercise-picker-options");
  container.innerHTML = optionCount > 0
    ? groupedExerciseCatalogHtml(groups, exercisePickerContext, "single")
    : '<p class="tool-picker-empty">Aucun exercice ne correspond à cette recherche.</p>';

  const resultLabel = `${optionCount} résultat${optionCount > 1 ? "s" : ""}`;
  byId("exercise-picker-count").textContent = `${resultLabel} dans ${groups.length} groupe${groups.length > 1 ? "s" : ""} musculaire${groups.length > 1 ? "s" : ""} · 1 sélectionné`;
  const searchActive = exercisePickerContext.query.trim().length > 0;
  byId("collapse-exercise-picker-groups").disabled = searchActive;
  byId("expand-exercise-picker-groups").disabled = searchActive;
  bindMuscleGroupDisclosures(container, exercisePickerContext);
  container.querySelectorAll('input[type="radio"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      exercisePickerContext.value = radio.value;
      const groupName = radio.closest("details[data-muscle-group]")?.dataset.muscleGroup;
      if (groupName) exercisePickerContext.openGroups.add(groupName);
      container.querySelectorAll(".tool-picker-option").forEach((label) => {
        label.classList.toggle("is-selected", label.querySelector("input")?.checked === true);
      });
    });
    radio.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (!radio.checked) {
        radio.checked = true;
        exercisePickerContext.value = radio.value;
      }
      applyExercisePicker();
    });
  });
};

const openExercisePicker = (rowId) => {
  if (!prepareCoachCommand()) return;
  const row = selectedSession()?.rows.find((candidate) => candidate.id === rowId);
  if (!row) return;
  const groups = exercisePickerGroups([row.exerciseName]);
  const currentGroup = groups.find((group) => group.options.some((option) => option.selected));
  exercisePickerContext = {
    rowId,
    value: row.exerciseName,
    query: "",
    openGroups: new Set(currentGroup ? [currentGroup.name] : [])
  };
  byId("exercise-picker-current").textContent = row.exerciseName;
  byId("exercise-picker-search").value = "";
  renderExercisePickerOptions();
  byId("exercise-picker-dialog").showModal();
  const selectedOption = document.querySelector('#exercise-picker-options input[type="radio"]:checked');
  if (selectedOption) selectedOption.scrollIntoView({ block: "center" });
  else byId("exercise-picker-options").scrollTop = 0;
  byId("exercise-picker-search").focus({ preventScroll: true });
};

const closeExercisePicker = () => {
  if (byId("exercise-picker-dialog").open) byId("exercise-picker-dialog").close();
  exercisePickerContext = null;
};

const applyExercisePicker = () => {
  if (!exercisePickerContext) return;
  const session = selectedSession();
  const row = session?.rows.find((candidate) => candidate.id === exercisePickerContext.rowId);
  if (!row) {
    closeExercisePicker();
    return;
  }
  const nextCell = { rowId: row.id, columnKey: "exerciseName" };
  selection = { anchor: nextCell, focus: nextCell };
  if (coachValuesEqual(row.exerciseName, exercisePickerContext.value)) {
    closeExercisePicker();
    renderCoachGrid(`${row.id}::exerciseName`);
    setCoachActivity("Sélection d’exercice refermée sans changement.");
    return;
  }
  try {
    const nextExerciseName = exercisePickerContext.value;
    const affectedSeriesCount = session.rows.filter(
      (candidate) => candidate.plannedExerciseId === row.plannedExerciseId
    ).length;
    const next = updateCoachCell(
      coachModel,
      coachModel.selectedSessionId,
      row.id,
      "exerciseName",
      nextExerciseName
    );
    const committed = commitCoachModel(
      next,
      `Exercice « ${nextExerciseName} » appliqué à ${affectedSeriesCount} série(s) en une action annulable.`,
      false
    );
    if (!committed) return;
    closeExercisePicker();
    renderCoachGrid(`${row.id}::exerciseName`);
  } catch (error) {
    showToast(error.message);
    setCoachActivity(`Exercice non appliqué : ${error.message}`);
  }
};

const exerciseBuilderOrderedSelection = () => {
  const selected = new Set(exerciseBuilderContext?.values ?? []);
  return exerciseMuscleGroups()
    .flatMap((group) => group.exercises)
    .filter((exerciseName) => selected.has(exerciseName));
};

const exerciseBuilderDefaults = () => ({
  setsPerExercise: Number(byId("exercise-builder-series").value),
  targetReps: byId("exercise-builder-repetitions").value,
  targetRir: Number(byId("exercise-builder-rir").value)
});

const syncExerciseBuilderSummary = (visibleOptionCount = null, visibleGroupCount = null) => {
  if (!exerciseBuilderContext) return;
  const values = exerciseBuilderOrderedSelection();
  const defaults = exerciseBuilderDefaults();
  const seriesInput = byId("exercise-builder-series");
  const validDefaults = seriesInput.checkValidity()
    && Number.isInteger(defaults.setsPerExercise)
    && defaults.setsPerExercise >= 1
    && defaults.setsPerExercise <= 10;
  const seriesCount = validDefaults ? values.length * defaults.setsPerExercise : 0;
  if (visibleOptionCount !== null) {
    const groupLabel = `${visibleGroupCount} groupe${visibleGroupCount > 1 ? "s" : ""}`;
    byId("exercise-builder-results").textContent = `${visibleOptionCount} résultat${visibleOptionCount > 1 ? "s" : ""} dans ${groupLabel}`;
  }
  byId("exercise-builder-count").textContent = validDefaults
    ? `${values.length} exercice${values.length > 1 ? "s" : ""} · ${seriesCount} série${seriesCount > 1 ? "s" : ""}`
    : `${values.length} exercice${values.length > 1 ? "s" : ""} · nombre de séries invalide`;
  const applyButton = byId("apply-exercise-builder");
  applyButton.disabled = values.length === 0 || !validDefaults;
  applyButton.textContent = values.length === 0
    ? "Choisir au moins un exercice"
    : `Créer ${values.length} exercice${values.length > 1 ? "s" : ""} · ${seriesCount} série${seriesCount > 1 ? "s" : ""}`;
  byId("clear-exercise-builder").disabled = values.length === 0;
};

const focusExerciseBuilderOption = (value) => {
  const option = [...document.querySelectorAll('#exercise-builder-options input[type="checkbox"]')]
    .find((candidate) => candidate.value === value);
  option?.focus({ preventScroll: true });
};

const renderExerciseBuilderOptions = () => {
  if (!exerciseBuilderContext) return;
  exerciseBuilderContext.query = byId("exercise-builder-search").value;
  const groups = exercisePickerGroups(
    exerciseBuilderContext.values,
    exerciseBuilderContext.query
  );
  const optionCount = groups.reduce((count, group) => count + group.options.length, 0);
  const container = byId("exercise-builder-options");
  container.innerHTML = optionCount > 0
    ? groupedExerciseCatalogHtml(groups, exerciseBuilderContext, "multiple")
    : '<p class="tool-picker-empty">Aucun exercice ne correspond à cette recherche.</p>';
  bindMuscleGroupDisclosures(container, exerciseBuilderContext);
  syncExerciseBuilderSummary(optionCount, groups.length);
  const searchActive = exerciseBuilderContext.query.trim().length > 0;
  byId("collapse-exercise-builder-groups").disabled = searchActive;
  byId("expand-exercise-builder-groups").disabled = searchActive;

  container.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const changedValue = checkbox.value;
      const groupName = checkbox.closest("details[data-muscle-group]")?.dataset.muscleGroup;
      if (groupName) exerciseBuilderContext.openGroups.add(groupName);
      exerciseBuilderContext.values = checkbox.checked
        ? [...exerciseBuilderContext.values, changedValue]
        : exerciseBuilderContext.values.filter((value) => value !== changedValue);
      renderExerciseBuilderOptions();
      focusExerciseBuilderOption(changedValue);
    });
    checkbox.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      checkbox.click();
    });
  });
  container.querySelectorAll("[data-builder-toggle-group]").forEach((button) => {
    button.addEventListener("click", () => {
      const group = groups.find((candidate) => candidate.name === button.dataset.builderToggleGroup);
      if (!group) return;
      const groupValues = group.options.map((option) => option.value);
      const selected = new Set(exerciseBuilderContext.values);
      const allSelected = groupValues.every((value) => selected.has(value));
      exerciseBuilderContext.openGroups.add(group.name);
      groupValues.forEach((value) => {
        if (allSelected) selected.delete(value);
        else selected.add(value);
      });
      exerciseBuilderContext.values = [...selected];
      renderExerciseBuilderOptions();
      const reopenedGroup = [...document.querySelectorAll("#exercise-builder-options details")]
        .find((details) => details.dataset.muscleGroup === group.name);
      reopenedGroup?.querySelector("[data-builder-toggle-group]")?.focus({ preventScroll: true });
    });
  });
};

const openExerciseBuilder = () => {
  if (!prepareCoachCommand()) return;
  const session = selectedSession();
  if (!session || session.rows.length > 0) {
    showToast("La composition multiple est réservée à une séance vierge.");
    return;
  }
  exerciseBuilderContext = {
    values: [],
    query: "",
    openGroups: new Set()
  };
  byId("exercise-builder-search").value = "";
  byId("exercise-builder-series").value = "2";
  byId("exercise-builder-repetitions").value = prescriptionCatalog.repetitionTargets.includes("9-12")
    ? "9-12"
    : prescriptionCatalog.repetitionTargets[0];
  byId("exercise-builder-rir").value = "0";
  renderExerciseBuilderOptions();
  byId("exercise-builder-dialog").showModal();
  byId("exercise-builder-search").focus({ preventScroll: true });
};

const closeExerciseBuilder = () => {
  if (byId("exercise-builder-dialog").open) byId("exercise-builder-dialog").close();
  exerciseBuilderContext = null;
};

const applyExerciseBuilder = () => {
  if (!exerciseBuilderContext) return;
  const exerciseNames = exerciseBuilderOrderedSelection();
  const defaults = exerciseBuilderDefaults();
  if (!byId("exercise-builder-series").reportValidity() || exerciseNames.length === 0) return;
  try {
    const result = insertExercisesInEmptySession(
      coachModel,
      coachModel.selectedSessionId,
      exerciseNames,
      defaults
    );
    const firstCellId = `${result.firstRowId}::exerciseName`;
    selection = {
      anchor: { rowId: result.firstRowId, columnKey: "exerciseName" },
      focus: { rowId: result.firstRowId, columnKey: "exerciseName" }
    };
    const committed = commitCoachModel(
      result.model,
      `${result.exerciseCount} exercice(s) et ${result.seriesCount} série(s) créés en une action annulable.`,
      false
    );
    if (!committed) return;
    closeExerciseBuilder();
    renderCoach(firstCellId);
    showToast(`${result.exerciseCount} exercice(s) ajoutés dans l’ordre du catalogue.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    showToast(message);
    setCoachActivity(`Composition non appliquée : ${message}.`);
  }
};

const renderToolPickerOptions = () => {
  if (!toolPickerContext) return;
  const options = catalogPickerOptions(
    prescriptionCatalog.tools,
    toolPickerContext.values,
    byId("tool-picker-search").value
  );
  const selectedCount = toolPickerContext.values.length;

  byId("tool-picker-options").innerHTML = options.length > 0
    ? options.map((option) => {
      const disabled = !option.selected && selectedCount >= MAX_TOOLS_PER_EXERCISE;
      return `<label class="tool-picker-option ${option.selected ? "is-selected" : ""} ${option.legacy ? "is-legacy" : ""}">
        <input type="checkbox" value="${escapeHtml(option.value)}" ${option.selected ? "checked" : ""} ${disabled ? "disabled" : ""}>
        <span><strong>${escapeHtml(option.value)}</strong>${option.legacy ? "<small>Valeur existante hors catalogue</small>" : ""}</span>
      </label>`;
    }).join("")
    : '<p class="tool-picker-empty">Aucun outil ne correspond à cette recherche.</p>';

  byId("tool-picker-count").textContent = `${selectedCount} / ${MAX_TOOLS_PER_EXERCISE} sélectionné(s)`;
  byId("clear-tool-picker").disabled = selectedCount === 0;
  document.querySelectorAll('#tool-picker-options input[type="checkbox"]').forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const changedTool = checkbox.value;
      const previousOptions = [...document.querySelectorAll('#tool-picker-options input[type="checkbox"]')];
      const previousIndex = previousOptions.indexOf(checkbox);
      if (checkbox.checked) toolPickerContext.values.push(checkbox.value);
      else toolPickerContext.values = toolPickerContext.values.filter((tool) => tool !== checkbox.value);
      renderToolPickerOptions();
      const nextOptions = [...document.querySelectorAll('#tool-picker-options input[type="checkbox"]')];
      const nextFocus = nextOptions.find((candidate) => candidate.value === changedTool)
        ?? nextOptions[Math.min(previousIndex, nextOptions.length - 1)]
        ?? byId("tool-picker-search");
      nextFocus.focus({ preventScroll: true });
    });
  });
};

const openToolPicker = (rowId) => {
  if (!prepareCoachCommand()) return;
  const row = selectedSession()?.rows.find((candidate) => candidate.id === rowId);
  if (!row) return;
  toolPickerContext = {
    rowId,
    values: canonicalizeCatalogValues(prescriptionCatalog.tools, row.tools)
  };
  byId("tool-picker-exercise").textContent = row.exerciseName;
  byId("tool-picker-search").value = "";
  renderToolPickerOptions();
  byId("tool-picker-dialog").showModal();
  const selectedOption = document.querySelector('#tool-picker-options input[type="checkbox"]:checked');
  if (selectedOption) selectedOption.scrollIntoView({ block: "center" });
  else byId("tool-picker-options").scrollTop = 0;
  byId("tool-picker-search").focus({ preventScroll: true });
};

const closeToolPicker = () => {
  byId("tool-picker-dialog").close();
  toolPickerContext = null;
};

const applyToolPicker = () => {
  if (!toolPickerContext) return;
  const row = selectedSession()?.rows.find((candidate) => candidate.id === toolPickerContext.rowId);
  if (!row) {
    closeToolPicker();
    return;
  }
  const nextCell = { rowId: row.id, columnKey: "tools" };
  selection = { anchor: nextCell, focus: nextCell };
  if (coachValuesEqual(row.tools, toolPickerContext.values)) {
    closeToolPicker();
    renderCoachGrid(`${row.id}::tools`);
    setCoachActivity("Sélection d'outils refermée sans changement.");
    return;
  }
  try {
    const selectedToolCount = toolPickerContext.values.length;
    const next = updateCoachCell(
      coachModel,
      coachModel.selectedSessionId,
      row.id,
      "tools",
      toolPickerContext.values
    );
    const committed = commitCoachModel(
      next,
      `${selectedToolCount} outil(s) appliqué(s) à toutes les séries de « ${row.exerciseName} ».`,
      `${row.id}::tools`
    );
    if (committed) closeToolPicker();
  } catch (error) {
    showToast(error.message);
  }
};

const prescriptionPickerConfiguration = (field, row) => {
  const restPresetLabels = prescriptionCatalog.restPresets.map((preset) => preset.label);
  const matchingRestPreset = prescriptionCatalog.restPresets.find(
    (preset) => preset.seconds === row.restSeconds
  );
  const configurations = {
    targetReps: {
      field,
      title: "Choisir les répétitions",
      description: `Série ${row.setRank} de « ${row.exerciseName} ». Le choix concerne uniquement cette série.`,
      searchLabel: `Rechercher dans les ${prescriptionCatalog.repetitionTargets.length} cibles initiales`,
      searchPlaceholder: "Ex. 8-10, MAX, 0’45…",
      optionsLabel: "Cibles de répétitions disponibles",
      applyLabel: "Appliquer la cible",
      values: prescriptionCatalog.repetitionTargets,
      currentValue: canonicalizeCatalogValue(prescriptionCatalog.repetitionTargets, row.targetReps),
      toModelValue: (value) => value
    },
    restSeconds: {
      field,
      title: "Choisir le repos",
      description: `Exercice « ${row.exerciseName} ». Le choix est appliqué à toutes ses séries.`,
      searchLabel: `Rechercher dans les ${prescriptionCatalog.restPresets.length} durées initiales`,
      searchPlaceholder: "Ex. 1’30, 3’, 5’30…",
      optionsLabel: "Durées de repos disponibles",
      applyLabel: "Appliquer le repos",
      values: restPresetLabels,
      currentValue: canonicalizeCatalogValue(
        restPresetLabels,
        matchingRestPreset?.label ?? formatRestDuration(row.restSeconds)
      ),
      toModelValue: (value) => prescriptionCatalog.restPresets.find(
        (preset) => preset.label === value
      )?.seconds ?? parseRestDuration(value)
    },
    technique: {
      field,
      title: "Choisir la technique",
      description: `Série ${row.setRank} de « ${row.exerciseName} ». Une série peut ne comporter aucune technique.`,
      searchLabel: `Rechercher dans les ${prescriptionCatalog.techniques.length} techniques initiales`,
      searchPlaceholder: "Ex. superset, myoreps, drop…",
      optionsLabel: "Techniques disponibles",
      applyLabel: "Appliquer la technique",
      values: prescriptionCatalog.techniques,
      currentValue: row.technique
        ? canonicalizeCatalogValue(prescriptionCatalog.techniques, row.technique)
        : "",
      toModelValue: (value) => value,
      optional: true
    }
  };
  return configurations[field] ?? null;
};

const renderPrescriptionPickerOptions = () => {
  if (!prescriptionPickerContext) return;
  const row = selectedSession()?.rows.find(
    (candidate) => candidate.id === prescriptionPickerContext.rowId
  );
  if (!row) return;
  const configuration = prescriptionPickerConfiguration(prescriptionPickerContext.field, row);
  if (!configuration) return;
  const query = byId("prescription-picker-search").value;
  let catalogQuery = query.replace(/[-—−]/gu, "–").replace(/['′]/gu, "’");
  if (query.trim()) {
    try {
      catalogQuery = prescriptionPickerContext.field === "targetReps"
          ? parseRepetitionTarget(query).label
          : query;
    } catch {
      // Une recherche partielle reste utile même si elle ne forme pas encore une valeur métier complète.
    }
  }
  const queryForEmpty = query.trim().toLocaleLowerCase("fr-FR");
  const emptyOption = configuration.optional
    && (!queryForEmpty || "aucune technique".includes(queryForEmpty))
    ? [{ value: "", selected: prescriptionPickerContext.value === "", legacy: false, empty: true }]
    : [];
  const options = [
    ...emptyOption,
    ...catalogPickerOptions(configuration.values, prescriptionPickerContext.value, catalogQuery)
  ];

  byId("prescription-picker-options").innerHTML = options.length > 0
    ? options.map((option) => `<label class="tool-picker-option ${option.selected ? "is-selected" : ""} ${option.legacy ? "is-legacy" : ""} ${option.empty ? "is-empty" : ""}">
        <input type="radio" name="prescription-picker-choice" value="${escapeHtml(option.value)}" ${option.selected ? "checked" : ""}>
        <span><strong>${escapeHtml(option.empty ? "Aucune technique" : option.value)}</strong>${option.legacy ? "<small>Valeur existante hors catalogue</small>" : ""}</span>
      </label>`).join("")
    : '<p class="tool-picker-empty">Aucune valeur ne correspond à cette recherche.</p>';

  const resultLabel = `${options.length} résultat${options.length > 1 ? "s" : ""}`;
  byId("prescription-picker-count").textContent = `${resultLabel} · 1 valeur sélectionnée`;
  document.querySelectorAll('#prescription-picker-options input[type="radio"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      prescriptionPickerContext.value = radio.value;
      document.querySelectorAll("#prescription-picker-options .tool-picker-option").forEach((label) => {
        label.classList.toggle("is-selected", label.querySelector("input")?.checked === true);
      });
    });
    radio.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (!radio.checked) {
        radio.checked = true;
        prescriptionPickerContext.value = radio.value;
      }
      applyPrescriptionPicker();
    });
  });
};

const openPrescriptionPicker = (rowId, field) => {
  if (!prepareCoachCommand()) return;
  const row = selectedSession()?.rows.find((candidate) => candidate.id === rowId);
  if (!row) return;
  const configuration = prescriptionPickerConfiguration(field, row);
  if (!configuration) return;
  prescriptionPickerContext = { rowId, field, value: configuration.currentValue };
  byId("prescription-picker-title").textContent = configuration.title;
  byId("prescription-picker-description").textContent = configuration.description;
  byId("prescription-picker-current").textContent = configuration.currentValue || "Aucune technique";
  byId("prescription-picker-search-label").textContent = configuration.searchLabel;
  byId("prescription-picker-search").placeholder = configuration.searchPlaceholder;
  byId("prescription-picker-search").value = "";
  byId("prescription-picker-options").setAttribute("aria-label", configuration.optionsLabel);
  byId("apply-prescription-picker").textContent = configuration.applyLabel;
  renderPrescriptionPickerOptions();
  byId("prescription-picker-dialog").showModal();
  const selectedOption = document.querySelector('#prescription-picker-options input[type="radio"]:checked');
  if (selectedOption) selectedOption.scrollIntoView({ block: "center" });
  else byId("prescription-picker-options").scrollTop = 0;
  byId("prescription-picker-search").focus({ preventScroll: true });
};

const closePrescriptionPicker = () => {
  if (byId("prescription-picker-dialog").open) byId("prescription-picker-dialog").close();
  prescriptionPickerContext = null;
};

const applyPrescriptionPicker = () => {
  if (!prescriptionPickerContext) return;
  const session = selectedSession();
  const row = session?.rows.find((candidate) => candidate.id === prescriptionPickerContext.rowId);
  if (!row) {
    closePrescriptionPicker();
    return;
  }
  const configuration = prescriptionPickerConfiguration(prescriptionPickerContext.field, row);
  if (!configuration) return;
  const field = prescriptionPickerContext.field;
  const nextCell = { rowId: row.id, columnKey: field };
  selection = { anchor: nextCell, focus: nextCell };
  try {
    const nextValue = configuration.toModelValue(prescriptionPickerContext.value);
    const next = updateCoachCell(
      coachModel,
      coachModel.selectedSessionId,
      row.id,
      field,
      nextValue
    );
    const updatedRow = next.sessions
      .find((candidate) => candidate.id === next.selectedSessionId)
      ?.rows.find((candidate) => candidate.id === row.id);
    if (coachValuesEqual(row[field], updatedRow?.[field])) {
      closePrescriptionPicker();
      renderCoachGrid(`${row.id}::${field}`);
      setCoachActivity("Sélection refermée sans changement.");
      return;
    }
    const affectedSeriesCount = field === "restSeconds"
      ? session.rows.filter((candidate) => candidate.plannedExerciseId === row.plannedExerciseId).length
      : 1;
    const activity = field === "restSeconds"
      ? `Repos ${formatRestDuration(updatedRow.restSeconds)} appliqué à ${affectedSeriesCount} série(s) en une action annulable.`
      : field === "technique"
        ? `${updatedRow.technique ? `Technique « ${updatedRow.technique} » appliquée` : "Technique retirée"} sur la série ${row.setRank} en une action annulable.`
        : `Cible « ${updatedRow.targetReps} » appliquée à la série ${row.setRank} en une action annulable.`;
    const committed = commitCoachModel(next, activity, false);
    if (!committed) return;
    closePrescriptionPicker();
    renderCoachGrid(`${row.id}::${field}`);
  } catch (error) {
    showToast(error.message);
    setCoachActivity(`Valeur non appliquée : ${error.message}`);
  }
};

const coachCellFromPointerTarget = (target) => {
  const cell = target?.closest?.(".grid-cell");
  return cell && document.querySelector(".coach-grid")?.contains(cell) ? cell : null;
};

const coachSelectionCell = (cell) => ({
  rowId: cell.dataset.rowId,
  columnKey: cell.dataset.columnKey
});

const finishCoachPointerSelection = ({ suppressClick = false } = {}) => {
  const wasDragging = coachPointerSelection?.dragging === true;
  coachPointerSelection = null;
  document.body.classList.remove("is-drag-selecting");
  if (!wasDragging) return;
  if (suppressClick) {
    suppressCoachGridClick = true;
    window.setTimeout(() => { suppressCoachGridClick = false; }, 0);
  }
  setCoachActivity(`${selectedCellIds().length} cellule(s) sélectionnée(s) à la souris.`);
};

const beginCoachPointerSelection = (event) => {
  if (event.pointerType !== "mouse" || event.button !== 0) return;
  const cell = coachCellFromPointerTarget(event.target);
  if (!cell) return;
  const nextCell = coachSelectionCell(cell);
  selection = event.shiftKey && selection.anchor
    ? { anchor: selection.anchor, focus: nextCell }
    : { anchor: nextCell, focus: nextCell };
  coachPointerSelection = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    dragging: false
  };
  repaintCoachSelection();
};

const updateCoachPointerSelection = (event) => {
  if (!coachPointerSelection || event.pointerId !== coachPointerSelection.pointerId) return;
  if ((event.buttons & 1) === 0) {
    finishCoachPointerSelection();
    return;
  }
  if (!coachPointerSelection.dragging) {
    const distance = Math.hypot(
      event.clientX - coachPointerSelection.startX,
      event.clientY - coachPointerSelection.startY
    );
    if (distance < 5) return;
    coachPointerSelection.dragging = true;
    document.body.classList.add("is-drag-selecting");
  }
  event.preventDefault();
  const hitTarget = document.elementFromPoint(event.clientX, event.clientY);
  const cell = coachCellFromPointerTarget(hitTarget);
  if (!cell) return;
  const nextCell = coachSelectionCell(cell);
  if (selection.focus?.rowId === nextCell.rowId
    && selection.focus?.columnKey === nextCell.columnKey) return;
  selection = { anchor: selection.anchor ?? nextCell, focus: nextCell };
  repaintCoachSelection();
};

const bindCoachPointerSelection = () => {
  const grid = document.querySelector(".coach-grid");
  grid.addEventListener("pointerdown", beginCoachPointerSelection);
  grid.addEventListener("click", (event) => {
    if (!suppressCoachGridClick) return;
    suppressCoachGridClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  document.addEventListener("pointermove", updateCoachPointerSelection, { passive: false });
  document.addEventListener("pointerup", (event) => {
    if (!coachPointerSelection || event.pointerId !== coachPointerSelection.pointerId) return;
    finishCoachPointerSelection({ suppressClick: true });
  });
  document.addEventListener("pointercancel", (event) => {
    if (!coachPointerSelection || event.pointerId !== coachPointerSelection.pointerId) return;
    finishCoachPointerSelection();
  });
};

const bindCoachGridEvents = () => {

  document.querySelectorAll(".grid-cell input").forEach((input) => {
    input.addEventListener("focus", () => {
      const nextCell = { rowId: input.dataset.rowId, columnKey: input.dataset.columnKey };
      const nextCellId = `${nextCell.rowId}::${nextCell.columnKey}`;
      const preservesSelection = programmaticCoachFocusCellId === nextCellId;
      const alreadyFocused = selection.focus?.rowId === nextCell.rowId
        && selection.focus?.columnKey === nextCell.columnKey;
      if (!preservesSelection && !alreadyFocused) {
        selection = { anchor: nextCell, focus: nextCell };
        repaintCoachSelection();
      }
    });
    input.addEventListener("input", () => input.setCustomValidity(""));
    input.addEventListener("change", () => {
      if (coachInputIsDirty(input) && commitCoachInput(input, false)) syncCoachInputFromModel(input);
    });
    input.addEventListener("copy", (event) => {
      if (input.selectionStart !== input.selectionEnd) return;
      const clipboard = copyCoachSelection(input);
      if (!clipboard) return;
      event.clipboardData?.setData("text/plain", clipboard.tsv);
      try {
        event.clipboardData?.setData(COACH_CLIPBOARD_MIME, JSON.stringify(clipboard));
      } catch {
        // Le texte tabulé reste disponible quand le navigateur refuse un type personnalisé.
      }
      event.preventDefault();
    });
    input.addEventListener("paste", (event) => {
      if (input.selectionStart !== input.selectionEnd) return;
      let clipboard;
      try {
        clipboard = clipboardFromPasteEvent(event);
      } catch {
        event.preventDefault();
        showToast("Le presse-papiers interne est illisible.");
        return;
      }
      if (!clipboard) return;
      event.preventDefault();
      if (pasteCoachSelection(clipboard, input)) setCoachClipboard(clipboard);
    });
    input.addEventListener("keydown", (event) => {
      const navigationKeys = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Tab"]);
      if (!navigationKeys.has(event.key)) return;
      if (event.key === "Tab"
        && !event.shiftKey
        && CATALOG_PICKER_FIELDS.has(input.dataset.columnKey)) {
        event.preventDefault();
        if (!commitCoachInput(input, false)) return;
        syncCoachInputFromModel(input);
        const columnKey = input.dataset.columnKey;
        selection = {
          anchor: { rowId: input.dataset.rowId, columnKey },
          focus: { rowId: input.dataset.rowId, columnKey }
        };
        repaintCoachSelection();
        focusCatalogPickerButton({ rowId: input.dataset.rowId, columnKey });
        return;
      }
      const previousCell = event.key === "Tab" && event.shiftKey
        ? adjacentCoachCell(input.dataset.rowId, input.dataset.columnKey, -1)
        : null;
      if (previousCell && CATALOG_PICKER_FIELDS.has(previousCell.columnKey)) {
        event.preventDefault();
        if (!commitCoachInput(input, false)) return;
        syncCoachInputFromModel(input);
        selection = { anchor: previousCell, focus: previousCell };
        repaintCoachSelection();
        focusCatalogPickerButton(previousCell);
        return;
      }
      if ((event.key === "ArrowLeft" || event.key === "ArrowRight")
        && !horizontalArrowLeavesInput(input, event.key)) return;
      if (event.key === "Tab"
        && tabLeavesCoachGrid(input.dataset.rowId, input.dataset.columnKey, event.shiftKey)) {
        if (commitCoachInput(input, false)) scheduleCoachGridRefresh();
        else event.preventDefault();
        return;
      }
      event.preventDefault();
      if (!commitCoachInput(input, false)) return;
      moveGridFocus(
        input.dataset.rowId,
        input.dataset.columnKey,
        event.key,
        event.shiftKey,
        event.shiftKey && event.key.startsWith("Arrow")
      );
    });
  });
  document.querySelectorAll("[data-catalog-picker-row-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const rowId = button.dataset.catalogPickerRowId;
      const field = button.dataset.catalogPickerField;
      if (field === "exerciseName") openExercisePicker(rowId);
      else if (field === "tools") openToolPicker(rowId);
      else openPrescriptionPicker(rowId, field);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const rowId = button.dataset.catalogPickerRowId;
      const columnKey = button.dataset.catalogPickerField;
      if (event.shiftKey) {
        event.preventDefault();
        const input = document.querySelector(`[data-cell-id="${CSS.escape(`${rowId}::${columnKey}`)}"] input`);
        input?.focus({ preventScroll: true });
        return;
      }
      if (tabLeavesCoachGrid(rowId, columnKey, false)) {
        event.preventDefault();
        byId("coach-activity").focus({ preventScroll: true });
        return;
      }
      event.preventDefault();
      moveGridFocus(rowId, columnKey, "Tab", false, false);
    });
  });
};

const selectedCoachRow = () => {
  ensureSelection();
  return selectedSession()?.rows.find((row) => row.id === selection.focus?.rowId)
    ?? selectedSession()?.rows[0]
    ?? null;
};

const insertSelectedSeries = (position) => {
  if (!prepareCoachCommand()) return;
  if (selectedSession()?.rows.length === 0) {
    openExerciseBuilder();
    return;
  }
  const row = selectedCoachRow();
  const columnKey = row ? selection.focus?.columnKey ?? "exerciseName" : "exerciseName";
  try {
    const result = insertSeriesAtSelection(
      coachModel,
      coachModel.selectedSessionId,
      row?.id ?? null,
      position
    );
    const nextCell = { rowId: result.rowId, columnKey };
    selection = { anchor: nextCell, focus: nextCell };
    const cellId = `${nextCell.rowId}::${nextCell.columnKey}`;
    const committed = commitCoachModel(
      result.model,
      result.createdFirstExercise
        ? "Le premier exercice et sa première série ont été créés. Les valeurs proposées restent modifiables."
        : `Une série a été ajoutée ${position === "before" ? "avant" : "après"} la série active.`,
      cellId
    );
    if (committed && result.createdFirstExercise) {
      showToast("Première série créée. Renommez maintenant « Nouvel exercice ».");
      requestAnimationFrame(() => {
        const input = document.querySelector(`[data-cell-id="${CSS.escape(cellId)}"] input`);
        input?.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
        input?.select();
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    showToast(message);
    setCoachActivity(`Ajout non appliqué : ${message}.`);
  }
};

const removeSelectedSeries = () => {
  if (!prepareCoachCommand()) return;
  const row = selectedCoachRow();
  if (!row) return;
  const columnKey = selection.focus?.columnKey ?? "exerciseName";
  try {
    let result = removeSeries(coachModel, coachModel.selectedSessionId, row.id);
    let deletedExercise = false;
    if (result.requiresExerciseDeletion) {
      const confirmed = window.confirm(
        `« ${row.exerciseName} » ne contient qu'une série. Supprimer l'exercice complet ?`
      );
      if (!confirmed) {
        setCoachActivity("Suppression annulée : la dernière série et son exercice sont conservés.");
        return;
      }
      deletedExercise = true;
      result = removeSeries(
        coachModel,
        coachModel.selectedSessionId,
        row.id,
        { deleteExerciseWhenLast: true }
      );
    }
    const nextCell = result.nextRowId ? { rowId: result.nextRowId, columnKey } : null;
    selection = nextCell
      ? { anchor: nextCell, focus: nextCell }
      : { anchor: null, focus: null };
    const dissolution = result.dissolvedGroup
      ? " Le superset restant est redevenu un groupe simple."
      : "";
    commitCoachModel(
      result.model,
      deletedExercise
        ? `Exercice « ${row.exerciseName} » supprimé en une action annulable.${dissolution}`
        : `Une série de « ${row.exerciseName} » a été supprimée et les rangs ont été recalculés.${dissolution}`,
      nextCell ? `${nextCell.rowId}::${nextCell.columnKey}` : null
    );
  } catch (error) {
    showToast(error.message);
  }
};

const removeSelectedExercise = () => {
  if (!prepareCoachCommand()) return;
  const row = selectedCoachRow();
  if (!row) return;
  const seriesCount = selectedSession().rows.filter(
    (candidate) => candidate.plannedExerciseId === row.plannedExerciseId
  ).length;
  const confirmed = window.confirm(
    `Supprimer l’exercice complet « ${row.exerciseName} » et ses ${seriesCount} série${seriesCount > 1 ? "s" : ""} ?\n\nCette action pourra être annulée.`
  );
  if (!confirmed) {
    setCoachActivity(`Suppression annulée : l’exercice « ${row.exerciseName} » est conservé.`);
    return;
  }
  const columnKey = selection.focus?.columnKey ?? "exerciseName";
  try {
    const result = removeExercise(
      coachModel,
      coachModel.selectedSessionId,
      row.plannedExerciseId
    );
    const nextCell = result.nextRowId ? { rowId: result.nextRowId, columnKey } : null;
    selection = nextCell
      ? { anchor: nextCell, focus: nextCell }
      : { anchor: null, focus: null };
    const dissolution = result.dissolvedGroup
      ? " Le superset restant est redevenu un groupe simple."
      : "";
    commitCoachModel(
      result.model,
      `Exercice « ${row.exerciseName} » et ses ${result.removedCount} série${result.removedCount > 1 ? "s" : ""} supprimés en une action annulable.${dissolution}`,
      nextCell ? `${nextCell.rowId}::${nextCell.columnKey}` : null
    );
  } catch (error) {
    showToast(error.message);
    setCoachActivity(`Suppression non appliquée : ${error.message}`);
  }
};

const publishCoachClipboardText = (clipboard) => {
  if (!navigator.clipboard?.writeText) return;
  navigator.clipboard.writeText(clipboard.tsv).catch(() => {
    // Le bouton de collage interne reste fonctionnel sans autorisation système.
  });
};

const formatTargetSummary = (target) => {
  try {
    return parseRepetitionTarget(target).kind === "repetitions" ? `${target} rép.` : String(target);
  } catch {
    return String(target);
  }
};

const openClientPreview = () => {
  const session = selectedSession();
  const groups = [];
  for (const row of session.rows) {
    let group = groups.find((candidate) => candidate.id === row.groupId);
    if (!group) {
      group = { id: row.groupId, label: row.groupLabel, type: row.groupType, exercises: [] };
      groups.push(group);
    }
    let exercise = group.exercises.find((candidate) => candidate.id === row.plannedExerciseId);
    if (!exercise) {
      exercise = {
        id: row.plannedExerciseId,
        name: row.exerciseName,
        tools: row.tools,
        tempo: row.tempo,
        restSeconds: row.restSeconds,
        sets: []
      };
      group.exercises.push(exercise);
    }
    exercise.sets.push(row);
  }
  byId("client-preview-content").innerHTML = groups.map((group) => `
    <section class="preview-group">
      <div><strong>${escapeHtml(group.label)}</strong>${group.type === "superset" ? '<span class="superset-badge">Superset</span>' : ""}</div>
      ${group.exercises.map((exercise) => `
        <article class="preview-exercise">
          <h3>${escapeHtml(exercise.name)}</h3>
          ${exercise.tools.length ? `<p class="preview-tools">${escapeHtml(displayCoachValue("tools", exercise.tools))}</p>` : ""}
          <p class="preview-prescription">Tempo ${escapeHtml(exercise.tempo)} · Repos ${escapeHtml(formatRestDuration(exercise.restSeconds))}</p>
          <div>${exercise.sets.map((set) => `<span class="preview-set">${set.setRank} · ${escapeHtml(formatTargetSummary(set.targetReps))} · RIR ${set.targetRir === null ? "—" : escapeHtml(displayValue(set.targetRir))}${set.technique ? ` · ${escapeHtml(set.technique)}` : ""}</span>`).join("")}</div>
        </article>
      `).join("")}
    </section>
  `).join("") || '<p class="empty-preview">Cette séance ne contient aucun exercice.</p>';
  byId("client-preview-dialog").showModal();
};

const renderPastePreview = () => {
  const section = byId("paste-preview");
  if (!pastePreview) {
    section.hidden = true;
    byId("confirm-paste").disabled = true;
    return;
  }
  section.hidden = false;
  byId("paste-valid-count").textContent = `${pastePreview.accepted.length} ligne(s) valide(s)`;
  byId("paste-invalid-count").textContent = `${pastePreview.rejected.length} erreur(s)`;
  const entries = [
    ...pastePreview.accepted.map((entry) => {
      const details = [`${entry.values.exerciseName} · série ${entry.values.setRank}`];
      const tools = displayCoachValue("tools", entry.values.tools);
      if (tools) details.push(tools);
      if (entry.values.technique) details.push(entry.values.technique);
      return { ...entry, valid: true, detail: details.join(" · ") };
    }),
    ...pastePreview.rejected.map((entry) => ({ ...entry, valid: false, detail: entry.reason }))
  ].sort((a, b) => a.line - b.line);
  byId("paste-preview-rows").innerHTML = entries.map((entry) => `
    <div class="paste-row ${entry.valid ? "valid" : "invalid"}">
      <span aria-hidden="true">${entry.valid ? "✓" : "!"}</span>
      <div><strong>Ligne ${entry.line}</strong><p>${escapeHtml(entry.detail)}</p></div>
    </div>
  `).join("");
  byId("confirm-paste").disabled = pastePreview.accepted.length === 0;
};

const formatNumber = (value) => value === null || value === undefined ? "—" : String(value).replace(".", ",");

const CLIENT_STATUS = {
  in_progress: { badge: "En cours", todayEyebrow: "Séance du jour", workoutEyebrow: "Séance en cours" },
  completed: { badge: "Terminée", todayEyebrow: "Séance réalisée", workoutEyebrow: "Séance terminée" },
  skipped: { badge: "Sautée", todayEyebrow: "Séance sautée", workoutEyebrow: "Séance sautée" }
};

const clientStatus = () => CLIENT_STATUS[clientModel.status] ?? {
  badge: clientModel.status,
  todayEyebrow: "Séance",
  workoutEyebrow: "Séance"
};

const clientSets = () => clientModel.exercises.flatMap((exercise) => exercise.sets);

const findClientSet = (plannedSetId) => clientSets().find((set) => set.id === plannedSetId);

const findClientExerciseForSet = (plannedSetId) => clientModel.exercises.find((exercise) => (
  exercise.sets.some((set) => set.id === plannedSetId)
));

const pendingClientDraftIds = () => Object.keys(clientDrafts);

const renderedSetValues = (set) => {
  if (timingTrial?.plannedSetId === set.id) return timingTrial.sandboxValues;
  return clientDrafts[set.id] ?? set.values;
};

const updateClientInputBuffer = (form) => {
  const values = {
    reps: form.elements.reps.value,
    loadKg: form.elements.loadKg.value,
    rir: form.elements.rir.value
  };
  if (timingTrial?.plannedSetId === form.dataset.setId) {
    timingTrial.sandboxValues = values;
    return;
  }
  clientDrafts[form.dataset.setId] = values;
  const finishStatus = byId("finish-status");
  if (finishStatus) finishStatus.hidden = true;
};

const persistedSetCount = () => clientModel.exercises
  .flatMap((exercise) => exercise.sets)
  .filter((set) => set.isPersisted).length;

const renderToday = () => {
  const completed = persistedSetCount();
  const total = clientModel.exercises.flatMap((exercise) => exercise.sets).length;
  byId("today-session-name").textContent = clientModel.sessionName;
  byId("today-progress").textContent = `${completed} / ${total} série${completed > 1 ? "s" : ""}`;
  byId("coach-note").textContent = clientModel.coachNote;
  byId("today-session-status").textContent = clientStatus().badge;
  byId("today-session-eyebrow").textContent = clientStatus().todayEyebrow;
  const resumeButton = byId("resume-workout");
  resumeButton.firstChild.textContent = clientModel.status === "completed" ? "Revoir la séance " : "Reprendre la séance ";
};

const setSourceLabel = (set, isTimingTarget = false, isDraft = false) => {
  if (isTimingTarget) return '<span class="source-badge">Sandbox chrono</span>';
  if (isDraft) return '<span class="source-badge">Brouillon</span>';
  if (set.values.source === "currentSetLog") return '<span class="source-badge current">Reprise locale</span>';
  if (set.values.source === "previousPerformance") return '<span class="source-badge history">Prérempli</span>';
  return '<span class="source-badge">Vide</span>';
};

const renderWorkout = () => {
  const total = clientModel.exercises.flatMap((exercise) => exercise.sets).length;
  const completed = persistedSetCount();
  const readOnly = clientModel.status === "completed";
  const timingActive = Boolean(timingTrial);
  byId("workout-heading").textContent = clientModel.sessionName;
  byId("workout-progress").textContent = `${completed} / ${total}`;
  byId("workout-status-label").textContent = clientStatus().workoutEyebrow;
  byId("progress-bar").style.width = `${Math.round((completed / total) * 100)}%`;

  byId("exercise-list").innerHTML = clientModel.exercises.map((exercise) => `
    <article class="exercise-card ${exercise.groupType === "superset" ? "in-superset" : ""}">
      <header class="exercise-heading">
        <span class="exercise-label">${escapeHtml(exercise.label)}</span>
        <div><h3>${escapeHtml(exercise.name)}</h3><p>${exercise.groupType === "superset" ? `Superset ${escapeHtml(exercise.groupLabel)} · ` : ""}Tempo ${escapeHtml(exercise.tempo)} · repos ${escapeHtml(formatRestDuration(exercise.restSeconds))}</p></div>
        ${exercise.groupType === "superset" ? '<span class="superset-badge">Superset</span>' : ""}
      </header>
      <div class="set-list">${exercise.sets.map((set) => {
        const isTimingTarget = timingTrial?.plannedSetId === set.id;
        const isDraft = !isTimingTarget && Object.hasOwn(clientDrafts, set.id);
        const setReadOnly = readOnly || (timingActive && !isTimingTarget);
        const values = renderedSetValues(set);
        return `
        <form class="set-card ${set.isPersisted ? "saved" : ""} ${isTimingTarget ? "timing-target" : ""}" data-set-id="${escapeHtml(set.id)}">
          <div class="set-meta">
            <strong>Série ${set.rank}</strong>
            <span>Objectif ${escapeHtml(set.targetReps)} · RIR ${formatNumber(set.targetRir)}</span>
            <span class="previous-value">Préc. ${escapeHtml(set.previousDisplay)}</span>
            ${setSourceLabel(set, isTimingTarget, isDraft)}
          </div>
          <div class="set-inputs">
            <label class="input-field"><span>Rép.</span><input name="reps" inputmode="numeric" value="${escapeHtml(displayValue(values.reps))}" aria-label="Répétitions de ${escapeHtml(exercise.name)}, série ${set.rank}" ${setReadOnly ? "readonly" : ""}></label>
            <label class="input-field"><span>kg</span><input name="loadKg" inputmode="decimal" value="${escapeHtml(displayValue(values.loadKg))}" aria-label="Charge en kilogrammes de ${escapeHtml(exercise.name)}, série ${set.rank}" ${setReadOnly ? "readonly" : ""}></label>
            <label class="input-field"><span>RIR</span><input name="rir" inputmode="decimal" value="${escapeHtml(displayValue(values.rir))}" aria-label="RIR de ${escapeHtml(exercise.name)}, série ${set.rank}" ${setReadOnly ? "readonly" : ""}></label>
            <button class="set-save" type="submit" aria-label="${readOnly && !set.isPersisted ? "Série non saisie" : "Valider"} ${escapeHtml(exercise.name)}, série ${set.rank}" ${setReadOnly ? "disabled" : ""}>${set.isPersisted ? "✓" : readOnly ? "Non saisie" : "Valider"}</button>
          </div>
        </form>
      `; }).join("")}</div>
    </article>
  `).join("");

  document.querySelectorAll(".set-card").forEach((form) => form.addEventListener("submit", handleSetSave));
  document.querySelectorAll(".set-card input").forEach((input) => {
    input.addEventListener("input", () => updateClientInputBuffer(input.form));
  });
  document.querySelectorAll("[data-timing-mode]").forEach((button) => {
    button.disabled = readOnly || timingActive;
  });
  document.querySelectorAll("[data-indicator]").forEach((select) => {
    select.disabled = readOnly || timingActive;
  });
  byId("workout-comment").readOnly = readOnly || timingActive;
  byId("finish-workout").disabled = readOnly || timingActive;
  byId("finish-workout").textContent = readOnly
    ? "Séance terminée"
    : timingActive ? "Test chronométré en cours" : "Terminer la séance";
  if (readOnly) byId("finish-status").hidden = true;
  renderTimingStatus();
};

const renderTimingStatus = () => {
  const output = byId("timing-result");
  output.classList.remove("result-pass", "result-fail");
  if (timingTrial) {
    if (timingTrial.startedAt === null) {
      output.textContent = "Préparation du scénario et placement du focus…";
      return;
    }
    const expected = timingTrial.expected;
    output.textContent = timingTrial.mode === "unchanged"
      ? `Chrono en cours : validez la série 3 préremplie avant ${timingTrial.limit} s.`
      : `Chrono en cours : saisissez ${expected.reps} rép., ${displayValue(expected.loadKg)} kg et RIR ${displayValue(expected.rir)}, puis validez avant ${timingTrial.limit} s.`;
    return;
  }
  if (lastTimingResult) {
    output.textContent = `${lastTimingResult.passed ? "Seuil respecté" : "Seuil dépassé"} : ${lastTimingResult.elapsedSeconds.toFixed(1)} s sur ${lastTimingResult.maximumSeconds} s.`;
    output.classList.add(lastTimingResult.passed ? "result-pass" : "result-fail");
    return;
  }
  output.textContent = "Choisissez un scénario ; le chrono s'arrête à la validation.";
};

const sameNumber = (left, right) => {
  const normalize = (value) => value === "" || value === null || value === undefined ? null : Number(String(value).replace(",", "."));
  return normalize(left) === normalize(right);
};

const handleSetSave = (event) => {
  event.preventDefault();
  if (clientModel.status === "completed") return;
  const form = event.currentTarget;
  const plannedSetId = form.dataset.setId;
  const data = new FormData(form);
  const input = { reps: data.get("reps"), loadKg: data.get("loadKg"), rir: data.get("rir") };

  if (timingTrial?.plannedSetId === plannedSetId) {
    if (timingTrial.startedAt === null) {
      showToast("Le chronomètre se prépare encore.");
      return;
    }
    const expected = timingTrial.expected;
    const exact = sameNumber(input.reps, expected.reps)
      && sameNumber(input.loadKg, expected.loadKg)
      && sameNumber(input.rir, expected.rir);
    if (!exact) {
      showToast("Le scénario chronométré attend les trois valeurs indiquées.");
      return;
    }
    lastTimingResult = timingResult(timingTrial.startedAt, performance.now(), timingTrial.limit);
    timingTrial = null;
    renderWorkout();
    showToast(lastTimingResult.passed ? "Seuil chronométré respecté." : "Seuil chronométré dépassé.");
    return;
  }

  try {
    const nextClientModel = saveClientSet(clientModel, plannedSetId, input);
    if (!persistClient(nextClientModel)) return;
    clientModel = nextClientModel;
    delete clientDrafts[plannedSetId];
    byId("finish-status").hidden = true;
    const exercise = findClientExerciseForSet(plannedSetId);
    renderToday();
    renderWorkout();
    showToast("Série conservée localement, sans doublon.");
    startRestTimer(exercise?.restSeconds ?? 0);
  } catch (error) {
    showToast(error.message);
  }
};

const startTimingTrial = (mode) => {
  if (clientModel.status === "completed") return;
  const scenarioId = mode === "unchanged"
    ? "timing:unchanged-under-5s"
    : "timing:changed-under-10s";
  const scenario = fixture.uiScenarios.timingActions.find((candidate) => candidate.id === scenarioId);
  if (!scenario) return;
  const fresh = buildClientPrototype(fixture);
  const sourceSet = fresh.exercises.flatMap((exercise) => exercise.sets).find((set) => set.id === scenario.plannedSetId);
  if (!sourceSet) return;
  window.clearInterval(restInterval);
  byId("rest-timer").hidden = true;
  const trial = {
    mode,
    plannedSetId: scenario.plannedSetId,
    expected: clone(scenario.input),
    sandboxValues: {
      reps: sourceSet.values.reps,
      loadKg: sourceSet.values.loadKg,
      rir: sourceSet.values.rir
    },
    limit: scenario.maximumInteractionSeconds,
    startedAt: null
  };
  timingTrial = trial;
  lastTimingResult = null;
  renderWorkout();
  requestAnimationFrame(() => {
    const form = document.querySelector(`[data-set-id="${CSS.escape(scenario.plannedSetId)}"]`);
    form?.scrollIntoView({ behavior: "auto", block: "center" });
    const control = mode === "changed" ? form?.elements.reps : form?.querySelector("button[type=submit]");
    if (!control || timingTrial !== trial) {
      timingTrial = null;
      renderWorkout();
      showToast("Impossible de préparer le scénario chronométré.");
      return;
    }
    control.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      if (timingTrial !== trial) return;
      if (document.activeElement !== control) control.focus({ preventScroll: true });
      if (document.activeElement !== control) {
        timingTrial = null;
        renderWorkout();
        showToast("Le focus n'a pas pu être placé ; le chrono n'a pas démarré.");
        return;
      }
      timingTrial.startedAt = performance.now();
      renderTimingStatus();
    });
  });
};

const startRestTimer = (seconds) => {
  window.clearInterval(restInterval);
  const panel = byId("rest-timer");
  if (!seconds) {
    panel.hidden = true;
    showToast("Superset : enchaînez avec l'exercice suivant.");
    return;
  }
  let remaining = seconds;
  byId("rest-seconds").textContent = remaining;
  panel.hidden = false;
  restInterval = window.setInterval(() => {
    remaining -= 1;
    byId("rest-seconds").textContent = Math.max(remaining, 0);
    if (remaining <= 0) {
      window.clearInterval(restInterval);
      panel.hidden = true;
      showToast("Repos terminé.");
    }
  }, 1000);
};

const setMobileScreen = (screen) => {
  if (screen !== "workout" && timingTrial) timingTrial = null;
  activeMobileScreen = screen;
  byId("today-screen").hidden = screen !== "today";
  byId("workout-screen").hidden = screen !== "workout";
  if (screen === "workout") renderWorkout();
};

const syncIndicators = () => {
  const readOnly = clientModel.status === "completed";
  document.querySelectorAll("[data-indicator]").forEach((select) => {
    select.innerHTML = '<option value="">—</option>' + [1, 2, 3, 4, 5]
      .map((value) => `<option value="${value}">${value} / 5</option>`).join("");
    select.value = clientModel.indicators[select.dataset.indicator] ?? "";
    select.disabled = readOnly;
    select.onchange = () => {
      if (clientModel.status === "completed") return;
      const nextClientModel = clone(clientModel);
      nextClientModel.indicators[select.dataset.indicator] = select.value === "" ? null : Number(select.value);
      if (persistClient(nextClientModel)) clientModel = nextClientModel;
      else select.value = clientModel.indicators[select.dataset.indicator] ?? "";
    };
  });
  byId("workout-comment").value = clientModel.comment ?? "";
  byId("workout-comment").readOnly = readOnly;
};

const route = () => {
  const view = window.location.hash.startsWith("#client") ? "client" : "coach";
  if (view !== "client" && timingTrial) timingTrial = null;
  byId("coach-view").hidden = view !== "coach";
  byId("client-view").hidden = view !== "client";
  document.querySelectorAll("[data-view-link]").forEach((link) => {
    const active = link.dataset.viewLink === view;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  if (view === "client") {
    renderToday();
    setMobileScreen(activeMobileScreen);
  }
};

const syncBulkEditor = () => {
  const field = byId("bulk-field").value;
  const input = byId("bulk-value");
  const examples = {
    targetRir: "1,5",
    targetReps: "8-10",
    tempo: "2-0-2-0",
    restSeconds: "1’30",
    technique: ""
  };
  input.value = examples[field] ?? "";
  input.inputMode = field === "targetRir" ? "decimal" : "text";
  const listId = {
    targetReps: "repetition-target-options",
    restSeconds: "rest-preset-options",
    technique: "technique-options"
  }[field];
  if (listId) input.setAttribute("list", listId);
  else input.removeAttribute("list");
  input.placeholder = field === "technique" ? "Technique facultative" : "Nouvelle valeur";
};

const bindStaticEvents = () => {
  window.addEventListener("hashchange", route);
  bindCoachPointerSelection();
  byId("bulk-field").addEventListener("change", syncBulkEditor);
  byId("undo-action").addEventListener("click", () => {
    if (!undoStack.length) return;
    if (!prepareCoachCommand()) return;
    const previous = undoStack.at(-1);
    if (!persistCoach(previous)) {
      setCoachActivity("Annulation non appliquée : le brouillon local n'a pas pu être sauvegardé.");
      return;
    }
    redoStack.push(clone(coachModel));
    coachModel = undoStack.pop();
    selection = { anchor: null, focus: null };
    renderCoach();
    setCoachActivity("Dernière action annulée.");
  });
  byId("redo-action").addEventListener("click", () => {
    if (!redoStack.length) return;
    if (!prepareCoachCommand()) return;
    if (!redoStack.length) return;
    const restored = redoStack.at(-1);
    if (!persistCoach(restored)) {
      setCoachActivity("Rétablissement non appliqué : le brouillon local n'a pas pu être sauvegardé.");
      return;
    }
    undoStack.push(clone(coachModel));
    coachModel = redoStack.pop();
    selection = { anchor: null, focus: null };
    renderCoach();
    setCoachActivity("Action rétablie.");
  });
  byId("insert-series-before").addEventListener("click", () => insertSelectedSeries("before"));
  byId("insert-series-after").addEventListener("click", () => insertSelectedSeries("after"));
  byId("remove-series").addEventListener("click", removeSelectedSeries);
  byId("remove-exercise").addEventListener("click", removeSelectedExercise);
  byId("copy-selection").addEventListener("click", () => {
    const clipboard = copyCoachSelection();
    if (clipboard) publishCoachClipboardText(clipboard);
  });
  byId("paste-selection").addEventListener("click", () => pasteCoachSelection());
  byId("duplicate-exercise").addEventListener("click", () => {
    if (!prepareCoachCommand()) return;
    const row = selectedCoachRow();
    if (!row) return;
    commitCoachModel(
      duplicateExercise(coachModel, coachModel.selectedSessionId, row.plannedExerciseId),
      `Exercice « ${row.exerciseName} » dupliqué avec de nouveaux identifiants.`
    );
  });
  byId("duplicate-session").addEventListener("click", () => {
    if (!prepareCoachCommand()) return;
    const session = selectedSession();
    selection = { anchor: null, focus: null };
    commitCoachModel(duplicateSession(coachModel, session.id), `Séance « ${session.name} » dupliquée.`);
  });
  byId("reset-coach-draft").addEventListener("click", () => {
    const confirmed = window.confirm("Réinitialiser le brouillon coach local depuis la fixture publiée ?");
    if (!confirmed) return;
    try {
      window.localStorage.removeItem(COACH_STORAGE_KEY);
    } catch {
      showToast("Le navigateur refuse la réinitialisation du brouillon coach.");
      return;
    }
    coachModel = buildCoachPrototype(fixture);
    coachDraftRestored = false;
    coachDraftRestoreWarning = null;
    coachDraftMigrationOverflow = [];
    coachDraftMigrationRepairs = [];
    coachDraftExactBackupCreated = false;
    undoStack = [];
    redoStack = [];
    selection = { anchor: null, focus: null };
    coachClipboard = null;
    pastePreview = null;
    renderCoach();
    setCoachActivity("Brouillon local réinitialisé depuis la version fictive publiée.");
    showToast("Brouillon coach réinitialisé ; la fixture est intacte.");
  });
  byId("bulk-edit-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!prepareCoachCommand()) return;
    try {
      const field = byId("bulk-field").value;
      const result = applyBulkEdit(coachModel, coachModel.selectedSessionId, selectedCellIds(), field, byId("bulk-value").value);
      if (result.changed === 0) {
        setCoachActivity("Modification groupée sans changement : les valeurs étaient déjà identiques.");
        return;
      }
      commitCoachModel(result.model, `${result.changed} ligne(s) modifiée(s) en une action annulable.`);
    } catch (error) {
      showToast(error.message);
    }
  });
  byId("open-client-preview").addEventListener("click", () => {
    if (prepareCoachCommand()) openClientPreview();
  });
  byId("open-paste-dialog").addEventListener("click", () => {
    if (!prepareCoachCommand()) return;
    pastePreview = null;
    renderPastePreview();
    byId("paste-dialog").showModal();
    byId("paste-source").focus();
  });
  byId("insert-paste-example").addEventListener("click", () => {
    pastePreview = null;
    renderPastePreview();
    byId("paste-source").value = PASTE_EXAMPLE;
    byId("preview-paste").focus();
  });
  byId("paste-source").addEventListener("input", () => {
    if (!pastePreview) return;
    pastePreview = null;
    renderPastePreview();
  });
  byId("preview-paste").addEventListener("click", () => {
    pastePreview = parseSpreadsheetPaste(byId("paste-source").value);
    renderPastePreview();
  });
  byId("confirm-paste").addEventListener("click", () => {
    if (!pastePreview?.accepted.length) return;
    const count = pastePreview.accepted.length;
    const next = applySpreadsheetPaste(coachModel, coachModel.selectedSessionId, pastePreview);
    if (!commitCoachModel(
      next,
      `${count} ligne(s) valide(s) ajoutée(s) ; les erreurs ont été laissées de côté.`
    )) return;
    byId("paste-dialog").close();
    showToast(`${count} ligne(s) ajoutée(s) comme une action annulable.`);
  });
  byId("cancel-paste").addEventListener("click", () => byId("paste-dialog").close());
  byId("exercise-picker-search").addEventListener("input", () => {
    renderExercisePickerOptions();
    byId("exercise-picker-options").scrollTop = 0;
  });
  byId("exercise-picker-search").addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    const options = [...document.querySelectorAll('#exercise-picker-options input[type="radio"]')];
    if (options.length === 0) return;
    event.preventDefault();
    const selectedOption = options.find((option) => option.checked);
    const nextOption = selectedOption ?? (event.key === "ArrowDown" ? options[0] : options.at(-1));
    nextOption.focus({ preventScroll: false });
    nextOption.scrollIntoView({ block: "nearest" });
  });
  byId("collapse-exercise-picker-groups").addEventListener("click", () => {
    if (!exercisePickerContext) return;
    setExerciseGroupExpansion(
      exercisePickerContext,
      [exercisePickerContext.value],
      false,
      renderExercisePickerOptions
    );
  });
  byId("expand-exercise-picker-groups").addEventListener("click", () => {
    if (!exercisePickerContext) return;
    setExerciseGroupExpansion(
      exercisePickerContext,
      [exercisePickerContext.value],
      true,
      renderExercisePickerOptions
    );
  });
  byId("apply-exercise-picker").addEventListener("click", applyExercisePicker);
  byId("cancel-exercise-picker").addEventListener("click", closeExercisePicker);
  byId("exercise-picker-dialog").addEventListener("close", () => {
    exercisePickerContext = null;
  });
  byId("exercise-builder-search").addEventListener("input", () => {
    renderExerciseBuilderOptions();
    byId("exercise-builder-options").scrollTop = 0;
  });
  byId("exercise-builder-search").addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    const options = [...document.querySelectorAll('#exercise-builder-options input[type="checkbox"]')];
    if (options.length === 0) return;
    event.preventDefault();
    const nextOption = event.key === "ArrowDown" ? options[0] : options.at(-1);
    nextOption.focus({ preventScroll: false });
    nextOption.scrollIntoView({ block: "nearest" });
  });
  byId("collapse-exercise-builder-groups").addEventListener("click", () => {
    if (!exerciseBuilderContext) return;
    setExerciseGroupExpansion(
      exerciseBuilderContext,
      exerciseBuilderContext.values,
      false,
      renderExerciseBuilderOptions
    );
  });
  byId("expand-exercise-builder-groups").addEventListener("click", () => {
    if (!exerciseBuilderContext) return;
    setExerciseGroupExpansion(
      exerciseBuilderContext,
      exerciseBuilderContext.values,
      true,
      renderExerciseBuilderOptions
    );
  });
  byId("clear-exercise-builder").addEventListener("click", () => {
    if (!exerciseBuilderContext) return;
    exerciseBuilderContext.values = [];
    renderExerciseBuilderOptions();
  });
  ["exercise-builder-series", "exercise-builder-repetitions", "exercise-builder-rir"].forEach((id) => {
    byId(id).addEventListener(id === "exercise-builder-series" ? "input" : "change", () => {
      syncExerciseBuilderSummary();
    });
  });
  byId("apply-exercise-builder").addEventListener("click", applyExerciseBuilder);
  byId("cancel-exercise-builder").addEventListener("click", closeExerciseBuilder);
  byId("exercise-builder-dialog").addEventListener("close", () => {
    exerciseBuilderContext = null;
  });
  byId("tool-picker-search").addEventListener("input", renderToolPickerOptions);
  byId("clear-tool-picker").addEventListener("click", () => {
    if (!toolPickerContext) return;
    toolPickerContext.values = [];
    renderToolPickerOptions();
  });
  byId("apply-tool-picker").addEventListener("click", applyToolPicker);
  byId("cancel-tool-picker").addEventListener("click", closeToolPicker);
  byId("tool-picker-dialog").addEventListener("close", () => {
    toolPickerContext = null;
  });
  byId("prescription-picker-search").addEventListener("input", () => {
    renderPrescriptionPickerOptions();
    byId("prescription-picker-options").scrollTop = 0;
  });
  byId("prescription-picker-search").addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    const options = [...document.querySelectorAll('#prescription-picker-options input[type="radio"]')];
    if (options.length === 0) return;
    event.preventDefault();
    const selectedOption = options.find((option) => option.checked);
    const nextOption = selectedOption ?? (event.key === "ArrowDown" ? options[0] : options.at(-1));
    nextOption.focus({ preventScroll: false });
    nextOption.scrollIntoView({ block: "nearest" });
  });
  byId("apply-prescription-picker").addEventListener("click", applyPrescriptionPicker);
  byId("cancel-prescription-picker").addEventListener("click", closePrescriptionPicker);
  byId("prescription-picker-dialog").addEventListener("close", () => {
    prescriptionPickerContext = null;
  });
  byId("resume-workout").addEventListener("click", () => setMobileScreen("workout"));
  byId("back-to-today").addEventListener("click", () => setMobileScreen("today"));
  document.querySelectorAll("[data-timing-mode]").forEach((button) => {
    button.addEventListener("click", () => startTimingTrial(button.dataset.timingMode));
  });
  byId("skip-rest").addEventListener("click", () => {
    window.clearInterval(restInterval);
    byId("rest-timer").hidden = true;
    showToast("Repos passé.");
  });
  byId("finish-workout").addEventListener("click", () => {
    const pendingDraftIds = pendingClientDraftIds();
    if (pendingDraftIds.length) {
      const message = `${pendingDraftIds.length} série(s) contiennent une saisie non validée. Validez-les avant de terminer.`;
      byId("finish-status").textContent = message;
      byId("finish-status").hidden = false;
      showToast("Séance non terminée : une saisie de série reste à valider.");
      requestAnimationFrame(() => {
        const form = document.querySelector(`[data-set-id="${CSS.escape(pendingDraftIds[0])}"]`);
        form?.querySelector("input")?.focus({ preventScroll: false });
      });
      return;
    }
    const nextClientModel = clone(clientModel);
    nextClientModel.comment = byId("workout-comment").value.trim() || null;
    nextClientModel.status = "completed";
    if (!persistClient(nextClientModel)) return;
    clientModel = nextClientModel;
    window.clearInterval(restInterval);
    byId("rest-timer").hidden = true;
    renderToday();
    renderWorkout();
    syncIndicators();
    showToast("Séance terminée ; les suivis facultatifs peuvent rester vides.");
    setMobileScreen("today");
  });
  byId("reset-client-state").addEventListener("click", () => {
    try {
      window.localStorage.removeItem(CLIENT_STORAGE_KEY);
    } catch {
      showToast("Le navigateur refuse la réinitialisation locale.");
      return;
    }
    clientModel = buildClientPrototype(fixture);
    clientDrafts = {};
    timingTrial = null;
    lastTimingResult = null;
    syncIndicators();
    renderToday();
    renderWorkout();
    setMobileScreen("today");
    showToast("Démonstration client réinitialisée.");
  });
  document.querySelectorAll(".avatar-button, .tracking-actions button, .mobile-nav button").forEach((button) => {
    button.disabled = true;
    button.setAttribute("aria-disabled", "true");
    button.title = "Hors périmètre du prototype J1";
  });
};

const showLoadFailure = (error) => {
  settlePrototypeLoading("failed");
  document.querySelector("main").innerHTML = `
    <section class="load-error">
      <p class="eyebrow">Prototype indisponible</p>
      <h1>Impossible de charger les données fictives</h1>
      <p>${escapeHtml(error.message)}</p>
      <p>Lancez le serveur depuis la racine du dépôt avec <code>make prototype-j1</code>.</p>
      <button id="retry-prototype-load-failure" class="button button-primary" type="button">Réessayer le chargement</button>
    </section>`;
  byId("retry-prototype-load-failure").addEventListener("click", () => window.location.reload());
};

const init = async () => {
  try {
    const [fixtureResponse, catalogResponse] = await Promise.all([
      fetch(FIXTURE_URL),
      fetch(PRESCRIPTION_CATALOG_URL)
    ]);
    if (!fixtureResponse.ok) throw new Error(`Fixture : réponse HTTP ${fixtureResponse.status}`);
    if (!catalogResponse.ok) throw new Error(`Catalogue : réponse HTTP ${catalogResponse.status}`);
    fixture = await fixtureResponse.json();
    prescriptionCatalog = await catalogResponse.json();
    validateCatalogMuscleGroups(
      prescriptionCatalog.exercises,
      prescriptionCatalog.muscleGroups
    );
    renderPrescriptionDatalists();
    coachModel = restoreCoachDraft(fixture);
    clientModel = restoreClientPrototype(fixture, readClientStorage());
    bindStaticEvents();
    syncIndicators();
    renderCoach();
    renderToday();
    renderWorkout();
    route();
    settlePrototypeLoading("ready");
    if (coachDraftRestoreWarning) {
      setCoachActivity(coachDraftRestoreWarning);
      showToast(coachDraftExactBackupCreated
        ? "Ancien brouillon restauré avec une sauvegarde de sécurité."
        : "Ancien brouillon restauré ; les valeurs sources restent conservées.");
    } else if (coachDraftRestored) {
      setCoachActivity("Brouillon coach local restauré prudemment.");
    } else {
      setCoachActivity("Prêt pour le test coach.");
    }
  } catch (error) {
    showLoadFailure(error);
  }
};

init();
