import {
  COACH_COLUMNS,
  MAX_TOOLS_PER_EXERCISE,
  applyBulkEdit,
  applySpreadsheetPaste,
  buildClientPrototype,
  buildCoachPrototype,
  coachValuesEqual,
  copyCoachRectangle,
  duplicateExercise,
  duplicateGroup,
  duplicateSession,
  insertSeriesAtSelection,
  normalizeCoachValue,
  parseSpreadsheetPaste,
  pasteCoachRectangle,
  rectangularCellIds,
  removeSeries,
  restoreClientPrototype,
  saveClientSet,
  serializeClientPrototype,
  timingResult,
  updateCoachCell,
  upgradeCoachDraftModel
} from "./prototype-state.mjs?v=20260808.7";

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
const displayCoachValue = (field, value) => field === "tools" && Array.isArray(value)
  ? value.join(" ; ")
  : displayValue(value);
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
let toolPickerContext = null;
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
        || !Array.isArray(row.tools)
        || row.tools.length > MAX_TOOLS_PER_EXERCISE
        || row.tools.some((tool) => typeof tool !== "string" || tool.trim().length === 0)
        || new Set(row.tools.map((tool) => tool.normalize("NFC").toLocaleUpperCase("fr-FR"))).size !== row.tools.length
        || typeof row.technique !== "string"
        || rowIds.has(row.id)
        || plannedSetIds.has(row.plannedSetId)
        || COACH_COLUMNS.some((column) => !Object.hasOwn(row, column.key))) return false;
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
    button.disabled = !session;
    button.textContent = hasRows
      ? id === "insert-series-before" ? "＋ Avant" : "＋ Après"
      : "＋ 1er exercice";
    if (hasRows) {
      button.removeAttribute("aria-label");
    } else {
      button.setAttribute(
        "aria-label",
        `Créer le premier exercice — commande ${id === "insert-series-before" ? "Avant" : "Après"}`
      );
    }
    button.title = !session
      ? "Sélectionnez d'abord une séance"
      : hasRows
      ? "Ajouter une série par rapport à la série active"
      : "Créer le premier exercice et sa première série";
  });
  [
    "remove-series",
    "duplicate-exercise",
    "duplicate-group"
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
  byId("technique-options").innerHTML = renderOptions(prescriptionCatalog.techniques);
};

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
          <p>Créez le premier exercice avec sa série nº 1, ou collez des lignes depuis Sheets.</p>
          <button id="add-first-exercise" class="button button-primary" type="button">
            ＋ Créer le premier exercice
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
      const inputMode = ["setRank", "restSeconds"].includes(column.key) ? "numeric"
        : column.key === "targetRir" ? "decimal" : "text";
      const structuralAttributes = column.key === "setRank"
        ? ' readonly aria-readonly="true" title="Calculé d’après l’ordre des séries"'
        : "";
      const listId = {
        exerciseName: "exercise-options",
        tools: "tool-options",
        technique: "technique-options"
      }[column.key];
      const listAttribute = listId ? ` list="${listId}"` : "";
      const guidanceAttributes = column.key === "tools"
        ? ` placeholder="OUTIL 1 ; OUTIL 2" title="Séparez jusqu’à ${MAX_TOOLS_PER_EXERCISE} outils par un point-virgule"`
        : column.key === "technique"
          ? ' placeholder="Facultative" title="Une technique maximum ; laissez vide si aucune"'
          : "";
      const inputHtml = `<input value="${escapeHtml(displayCoachValue(column.key, row[column.key]))}" inputmode="${inputMode}"${listAttribute}${guidanceAttributes}
        aria-label="${escapeHtml(`${column.label}, ${row.exerciseName}, série ${row.setRank}`)}"
        data-row-id="${escapeHtml(row.id)}" data-column-key="${escapeHtml(column.key)}"${structuralAttributes}>`;
      const editorHtml = column.key === "tools"
        ? `<div class="tools-cell-editor">${inputHtml}<button class="tool-picker-button" type="button"
            aria-label="${escapeHtml(`Choisir les outils, ${row.exerciseName}, série ${row.setRank}`)}"
            aria-haspopup="dialog" data-tool-picker-row-id="${escapeHtml(row.id)}" title="Choisir jusqu’à 6 outils dans la liste">⌄</button></div>`
        : inputHtml;
      return `<td role="gridcell" class="grid-cell ${isSelected ? "is-selected" : ""} ${isAnchor ? "is-anchor" : ""}"
        data-cell-id="${escapeHtml(cellId)}" data-row-id="${escapeHtml(row.id)}"
        data-column-key="${escapeHtml(column.key)}" aria-selected="${isSelected}">
        ${editorHtml}
      </td>`;
    }).join("")}</tr>`;
  }).join("");

  byId("add-first-exercise")?.addEventListener("click", () => insertSelectedSeries("after"));
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
};

const prepareCoachCommand = (input = activeCoachInput()) => {
  const pendingInput = dirtyCoachInput() ?? input;
  if (pendingInput && !commitCoachInput(pendingInput, false)) {
    if (!pendingInput.checkValidity()) {
      setCoachActivity("Action interrompue : corrigez d’abord la cellule invalide.");
    }
    return false;
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

const toolSearchKey = (value) => String(value)
  .normalize("NFD")
  .replace(/\p{M}/gu, "")
  .toLocaleUpperCase("fr-FR");

const renderToolPickerOptions = () => {
  if (!toolPickerContext) return;
  const query = toolSearchKey(byId("tool-picker-search").value.trim());
  const selected = new Set(toolPickerContext.values);
  const configuredIdentities = new Set(prescriptionCatalog.tools.map(toolSearchKey));
  const legacyValues = toolPickerContext.values.filter((tool) => !configuredIdentities.has(toolSearchKey(tool)));
  const options = [...legacyValues, ...prescriptionCatalog.tools]
    .filter((tool, index, values) => values.findIndex((candidate) => toolSearchKey(candidate) === toolSearchKey(tool)) === index)
    .filter((tool) => !query || toolSearchKey(tool).includes(query));

  byId("tool-picker-options").innerHTML = options.length > 0
    ? options.map((tool) => {
      const isSelected = selected.has(tool);
      const isLegacy = !configuredIdentities.has(toolSearchKey(tool));
      const disabled = !isSelected && selected.size >= MAX_TOOLS_PER_EXERCISE;
      return `<label class="tool-picker-option ${isSelected ? "is-selected" : ""} ${isLegacy ? "is-legacy" : ""}">
        <input type="checkbox" value="${escapeHtml(tool)}" ${isSelected ? "checked" : ""} ${disabled ? "disabled" : ""}>
        <span><strong>${escapeHtml(tool)}</strong>${isLegacy ? "<small>Valeur existante hors catalogue</small>" : ""}</span>
      </label>`;
    }).join("")
    : '<p class="tool-picker-empty">Aucun outil ne correspond à cette recherche.</p>';

  byId("tool-picker-count").textContent = `${selected.size} / ${MAX_TOOLS_PER_EXERCISE} sélectionné(s)`;
  byId("clear-tool-picker").disabled = selected.size === 0;
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
  const configuredByIdentity = new Map(
    prescriptionCatalog.tools.map((tool) => [toolSearchKey(tool), tool])
  );
  toolPickerContext = {
    rowId,
    values: row.tools.map((tool) => configuredByIdentity.get(toolSearchKey(tool)) ?? tool)
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

const bindCoachGridEvents = () => {
  document.querySelectorAll(".grid-cell").forEach((cell) => {
    cell.addEventListener("pointerdown", (event) => {
      const nextCell = { rowId: cell.dataset.rowId, columnKey: cell.dataset.columnKey };
      selection = event.shiftKey && selection.anchor
        ? { anchor: selection.anchor, focus: nextCell }
        : { anchor: nextCell, focus: nextCell };
      repaintCoachSelection();
    });
  });

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
      if (coachInputIsDirty(input) && commitCoachInput(input, false)) scheduleCoachGridRefresh();
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
      if (event.key === "Tab" && !event.shiftKey && input.dataset.columnKey === "tools") {
        event.preventDefault();
        if (!commitCoachInput(input, false)) return;
        syncCoachInputFromModel(input);
        selection = {
          anchor: { rowId: input.dataset.rowId, columnKey: "tools" },
          focus: { rowId: input.dataset.rowId, columnKey: "tools" }
        };
        repaintCoachSelection();
        document.querySelector(`[data-tool-picker-row-id="${CSS.escape(input.dataset.rowId)}"]`)
          ?.focus({ preventScroll: true });
        return;
      }
      if (event.key === "Tab" && event.shiftKey && input.dataset.columnKey === "setRank") {
        event.preventDefault();
        selection = {
          anchor: { rowId: input.dataset.rowId, columnKey: "tools" },
          focus: { rowId: input.dataset.rowId, columnKey: "tools" }
        };
        repaintCoachSelection();
        document.querySelector(`[data-tool-picker-row-id="${CSS.escape(input.dataset.rowId)}"]`)
          ?.focus({ preventScroll: true });
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
  document.querySelectorAll("[data-tool-picker-row-id]").forEach((button) => {
    button.addEventListener("click", () => openToolPicker(button.dataset.toolPickerRowId));
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      event.preventDefault();
      const rowId = button.dataset.toolPickerRowId;
      if (event.shiftKey) {
        const input = document.querySelector(`[data-cell-id="${CSS.escape(`${rowId}::tools`)}"] input`);
        input?.focus({ preventScroll: true });
        return;
      }
      moveGridFocus(rowId, "tools", "Tab", false, false);
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

const publishCoachClipboardText = (clipboard) => {
  if (!navigator.clipboard?.writeText) return;
  navigator.clipboard.writeText(clipboard.tsv).catch(() => {
    // Le bouton de collage interne reste fonctionnel sans autorisation système.
  });
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
      exercise = { id: row.plannedExerciseId, name: row.exerciseName, tools: row.tools, sets: [] };
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
          <div>${exercise.sets.map((set) => `<span class="preview-set">${set.setRank} · ${escapeHtml(set.targetReps)} rép. · RIR ${set.targetRir === null ? "—" : escapeHtml(displayValue(set.targetRir))}${set.technique ? ` · ${escapeHtml(set.technique)}` : ""}</span>`).join("")}</div>
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
        <div><h3>${escapeHtml(exercise.name)}</h3><p>${exercise.groupType === "superset" ? `Superset ${escapeHtml(exercise.groupLabel)} · ` : ""}Tempo ${escapeHtml(exercise.tempo)} · repos ${exercise.restSeconds} s</p></div>
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
    restSeconds: "90",
    technique: ""
  };
  input.value = examples[field] ?? "";
  input.inputMode = ["targetRir"].includes(field) ? "decimal"
    : field === "restSeconds" ? "numeric" : "text";
  if (field === "technique") {
    input.setAttribute("list", "technique-options");
    input.placeholder = "Technique facultative";
  } else {
    input.removeAttribute("list");
    input.placeholder = "Nouvelle valeur";
  }
};

const bindStaticEvents = () => {
  window.addEventListener("hashchange", route);
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
  byId("duplicate-group").addEventListener("click", () => {
    if (!prepareCoachCommand()) return;
    const row = selectedCoachRow();
    if (!row) return;
    commitCoachModel(
      duplicateGroup(coachModel, coachModel.selectedSessionId, row.groupId),
      `${row.groupType === "superset" ? "Superset" : "Groupe"} ${row.groupLabel} dupliqué atomiquement.`
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
  document.querySelector("main").innerHTML = `
    <section class="load-error">
      <p class="eyebrow">Prototype indisponible</p>
      <h1>Impossible de charger les données fictives</h1>
      <p>${escapeHtml(error.message)}</p>
      <p>Lancez le serveur depuis la racine du dépôt avec <code>make prototype-j1</code>.</p>
    </section>`;
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
    renderPrescriptionDatalists();
    coachModel = restoreCoachDraft(fixture);
    clientModel = restoreClientPrototype(fixture, readClientStorage());
    bindStaticEvents();
    syncIndicators();
    renderCoach();
    if (coachDraftRestoreWarning) {
      setCoachActivity(coachDraftRestoreWarning);
      showToast(coachDraftExactBackupCreated
        ? "Ancien brouillon restauré avec une sauvegarde de sécurité."
        : "Ancien brouillon restauré ; les valeurs sources restent conservées.");
    } else if (coachDraftRestored) {
      setCoachActivity("Brouillon coach local restauré prudemment.");
    }
    renderToday();
    renderWorkout();
    route();
  } catch (error) {
    showLoadFailure(error);
  }
};

init();
