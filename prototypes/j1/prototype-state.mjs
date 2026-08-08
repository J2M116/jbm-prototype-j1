const clone = (value) => JSON.parse(JSON.stringify(value));

export const COACH_COLUMNS = [
  { key: "groupLabel", label: "Groupe" },
  { key: "exerciseName", label: "Exercice" },
  { key: "tools", label: "Outils" },
  { key: "setRank", label: "Série" },
  { key: "targetReps", label: "Répétitions" },
  { key: "targetRir", label: "RIR" },
  { key: "tempo", label: "Tempo" },
  { key: "restSeconds", label: "Repos (s)" },
  { key: "technique", label: "Technique" }
];

export const MAX_TOOLS_PER_EXERCISE = 6;

const catalogById = (fixture) => new Map(fixture.catalog.exercises.map((exercise) => [exercise.id, exercise]));
const toolsById = (fixture) => new Map(fixture.catalog.tools.map((tool) => [tool.id, tool.name]));

const tempoLabel = (tempo) => tempo
  ? [tempo.eccentric, tempo.pause1, tempo.concentric, tempo.pause2].join("-")
  : "Hérité";

export const buildCoachPrototype = (fixture) => {
  const exerciseCatalog = catalogById(fixture);
  const toolNames = toolsById(fixture);
  const groups = new Map(fixture.program.session.groups.map((group) => [group.id, group]));
  const rows = fixture.program.session.exercises.flatMap((plannedExercise) => {
    const catalogExercise = exerciseCatalog.get(plannedExercise.catalogExerciseId);
    const group = groups.get(plannedExercise.groupId);
    return plannedExercise.sets.map((set) => ({
      id: `coach-row:${set.id}`,
      plannedSetId: set.id,
      plannedExerciseId: plannedExercise.id,
      groupId: group.id,
      groupLabel: group.label,
      groupType: group.type,
      exerciseName: catalogExercise.name,
      tools: catalogExercise.toolIds.map((toolId) => toolNames.get(toolId)).filter(Boolean),
      setRank: set.rank,
      targetReps: `${set.targetRepsMin}–${set.targetRepsMax}`,
      targetRir: set.targetRir,
      tempo: tempoLabel(plannedExercise.tempo),
      restSeconds: plannedExercise.restSeconds,
      technique: set.technique ?? ""
    }));
  });
  const session = {
    id: `coach-session:${fixture.program.session.id}`,
    sourceSessionId: fixture.program.session.id,
    name: fixture.program.session.name,
    rows
  };
  return {
    fixtureId: fixture.fixtureId,
    programName: fixture.program.name,
    versionLabel: `v${fixture.program.version.number}`,
    status: "Brouillon de prototype",
    selectedSessionId: session.id,
    sessions: [session]
  };
};

const nextCopyOrdinal = (values, marker) => {
  const usedOrdinals = new Set();
  values.forEach((value) => {
    const serialized = String(value);
    const markerIndex = serialized.indexOf(marker);
    if (markerIndex < 0) return;
    const match = serialized.slice(markerIndex + marker.length).match(/^(\d+)(?::|$)/u);
    if (match) usedOrdinals.add(Number(match[1]));
  });
  let ordinal = 1;
  while (usedOrdinals.has(ordinal)) ordinal += 1;
  return ordinal;
};

const nextGroupLabel = (rows) => {
  const labels = new Set(rows.map((row) => row.groupLabel));
  for (const label of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    if (!labels.has(label)) return label;
  }
  return `G${labels.size + 1}`;
};

export const duplicateExercise = (model, sessionId, plannedExerciseId) => {
  const next = clone(model);
  const session = next.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error("Séance introuvable");
  const sourceRows = session.rows.filter((row) => row.plannedExerciseId === plannedExerciseId);
  if (sourceRows.length === 0) throw new Error("Exercice introuvable");
  const ordinal = nextCopyOrdinal(session.rows.map((row) => row.plannedExerciseId), `${plannedExerciseId}:copy:`);
  const copiedExerciseId = `${plannedExerciseId}:copy:${ordinal}`;
  const copiedGroupId = `${sourceRows[0].groupId}:exercise-copy:${ordinal}`;
  const copiedLabel = nextGroupLabel(session.rows);
  const copiedRows = sourceRows.map((row) => ({
    ...clone(row),
    id: `${row.id}:exercise-copy:${ordinal}`,
    plannedSetId: `${row.plannedSetId}:exercise-copy:${ordinal}`,
    plannedExerciseId: copiedExerciseId,
    groupId: copiedGroupId,
    groupLabel: copiedLabel,
    groupType: "simple",
    exerciseName: `${row.exerciseName} — copie`
  }));
  const lastIndex = Math.max(...sourceRows.map((row) => session.rows.findIndex((candidate) => candidate.id === row.id)));
  session.rows.splice(lastIndex + 1, 0, ...copiedRows);
  return next;
};

export const duplicateGroup = (model, sessionId, groupId) => {
  const next = clone(model);
  const session = next.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error("Séance introuvable");
  const sourceRows = session.rows.filter((row) => row.groupId === groupId);
  if (sourceRows.length === 0) throw new Error("Groupe introuvable");
  const ordinal = nextCopyOrdinal(session.rows.map((row) => row.groupId), `${groupId}:copy:`);
  const copiedGroupId = `${groupId}:copy:${ordinal}`;
  const copiedLabel = nextGroupLabel(session.rows);
  const copiedExerciseIds = new Map();
  const copiedRows = sourceRows.map((row) => {
    if (!copiedExerciseIds.has(row.plannedExerciseId)) {
      copiedExerciseIds.set(row.plannedExerciseId, `${row.plannedExerciseId}:group-copy:${ordinal}`);
    }
    return {
      ...clone(row),
      id: `${row.id}:group-copy:${ordinal}`,
      plannedSetId: `${row.plannedSetId}:group-copy:${ordinal}`,
      plannedExerciseId: copiedExerciseIds.get(row.plannedExerciseId),
      groupId: copiedGroupId,
      groupLabel: copiedLabel,
      exerciseName: `${row.exerciseName} — copie`
    };
  });
  const lastIndex = Math.max(...sourceRows.map((row) => session.rows.findIndex((candidate) => candidate.id === row.id)));
  session.rows.splice(lastIndex + 1, 0, ...copiedRows);
  return next;
};

export const duplicateSession = (model, sessionId) => {
  const next = clone(model);
  const source = next.sessions.find((candidate) => candidate.id === sessionId);
  if (!source) throw new Error("Séance introuvable");
  const ordinal = nextCopyOrdinal(next.sessions.map((session) => session.id), `${sessionId}:copy:`);
  const id = `${sessionId}:copy:${ordinal}`;
  const copied = {
    ...clone(source),
    id,
    name: `${source.name} — copie`,
    rows: source.rows.map((row) => ({
      ...clone(row),
      id: `${row.id}:session-copy:${ordinal}`,
      plannedSetId: `${row.plannedSetId}:session-copy:${ordinal}`,
      plannedExerciseId: `${row.plannedExerciseId}:session-copy:${ordinal}`,
      groupId: `${row.groupId}:session-copy:${ordinal}`
    }))
  };
  next.sessions.push(copied);
  next.selectedSessionId = id;
  return next;
};

const renumberExerciseRows = (session, plannedExerciseId) => {
  let rank = 0;
  session.rows.forEach((row) => {
    if (row.plannedExerciseId !== plannedExerciseId) return;
    rank += 1;
    row.setRank = rank;
  });
};

const nextInsertedSeriesOrdinal = (model) => {
  let ordinal = 1;
  const rows = model.sessions.flatMap((session) => session.rows);
  const rowIds = new Set(rows.map((row) => row.id));
  const setIds = new Set(rows.map((row) => row.plannedSetId));
  const exerciseIds = new Set(rows.map((row) => row.plannedExerciseId));
  const groupIds = new Set(rows.map((row) => row.groupId));
  while (rowIds.has(`coach-row:insert:${ordinal}`)
    || setIds.has(`insert-set:${ordinal}`)
    || exerciseIds.has(`insert-exercise:${ordinal}`)
    || groupIds.has(`insert-group:${ordinal}`)) ordinal += 1;
  return ordinal;
};

export const insertSeries = (model, sessionId, rowId, position = "after") => {
  if (!["before", "after"].includes(position)) throw new Error("Position d'insertion inconnue");
  const next = clone(model);
  const session = next.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error("Séance introuvable");
  const sourceIndex = session.rows.findIndex((row) => row.id === rowId);
  if (sourceIndex < 0) throw new Error("Série introuvable");
  const source = session.rows[sourceIndex];
  const ordinal = nextInsertedSeriesOrdinal(next);
  const inserted = {
    ...clone(source),
    id: `coach-row:insert:${ordinal}`,
    plannedSetId: `insert-set:${ordinal}`
  };
  const insertionIndex = sourceIndex + (position === "after" ? 1 : 0);
  session.rows.splice(insertionIndex, 0, inserted);
  renumberExerciseRows(session, source.plannedExerciseId);
  return {
    model: next,
    rowId: inserted.id,
    plannedSetId: inserted.plannedSetId
  };
};

export const insertExerciseWithFirstSeries = (model, sessionId) => {
  const next = clone(model);
  const session = next.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error("Séance introuvable");
  const ordinal = nextInsertedSeriesOrdinal(next);
  const inserted = {
    id: `coach-row:insert:${ordinal}`,
    plannedSetId: `insert-set:${ordinal}`,
    plannedExerciseId: `insert-exercise:${ordinal}`,
    groupId: `insert-group:${ordinal}`,
    groupLabel: session.rows.length === 0 ? "A" : nextGroupLabel(session.rows),
    groupType: "simple",
    exerciseName: "Nouvel exercice",
    tools: [],
    setRank: 1,
    targetReps: "10",
    targetRir: null,
    tempo: "Hérité",
    restSeconds: 60,
    technique: ""
  };
  session.rows.push(inserted);
  return {
    model: next,
    rowId: inserted.id,
    plannedSetId: inserted.plannedSetId,
    plannedExerciseId: inserted.plannedExerciseId,
    groupId: inserted.groupId
  };
};

export const insertSeriesAtSelection = (model, sessionId, rowId, position = "after") => {
  if (!["before", "after"].includes(position)) throw new Error("Position d'insertion inconnue");
  const session = model.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error("Séance introuvable");
  if (session.rows.length === 0) {
    return {
      ...insertExerciseWithFirstSeries(model, sessionId),
      createdFirstExercise: true
    };
  }
  if (!rowId) throw new Error("Série active introuvable");
  return {
    ...insertSeries(model, sessionId, rowId, position),
    createdFirstExercise: false
  };
};

export const removeSeries = (
  model,
  sessionId,
  rowId,
  { deleteExerciseWhenLast = false } = {}
) => {
  const sourceSession = model.sessions.find((candidate) => candidate.id === sessionId);
  if (!sourceSession) throw new Error("Séance introuvable");
  const sourceIndex = sourceSession.rows.findIndex((row) => row.id === rowId);
  if (sourceIndex < 0) throw new Error("Série introuvable");
  const source = sourceSession.rows[sourceIndex];
  const exerciseRows = sourceSession.rows.filter((row) => row.plannedExerciseId === source.plannedExerciseId);
  if (exerciseRows.length === 1 && !deleteExerciseWhenLast) {
    return {
      model,
      requiresExerciseDeletion: true,
      removedCount: 0,
      nextRowId: rowId
    };
  }

  const next = clone(model);
  const session = next.sessions.find((candidate) => candidate.id === sessionId);
  const idsToRemove = new Set(
    exerciseRows.length === 1 ? exerciseRows.map((row) => row.id) : [rowId]
  );
  session.rows = session.rows.filter((row) => !idsToRemove.has(row.id));
  renumberExerciseRows(session, source.plannedExerciseId);
  const remainingGroupRows = session.rows.filter((row) => row.groupId === source.groupId);
  const remainingGroupExerciseIds = new Set(remainingGroupRows.map((row) => row.plannedExerciseId));
  const dissolvedGroup = source.groupType !== "simple" && remainingGroupExerciseIds.size === 1;
  if (dissolvedGroup) remainingGroupRows.forEach((row) => { row.groupType = "simple"; });
  const nextRow = session.rows[Math.min(sourceIndex, session.rows.length - 1)] ?? null;
  return {
    model: next,
    requiresExerciseDeletion: false,
    removedCount: idsToRemove.size,
    dissolvedGroup,
    nextRowId: nextRow?.id ?? null
  };
};

const toolIdentity = (value) => value.normalize("NFC").toLocaleUpperCase("fr-FR");

export const parseCoachTools = (rawValue) => {
  const source = Array.isArray(rawValue) ? rawValue : String(rawValue ?? "").split(/\s*;\s*|\r?\n+/u);
  const tools = [];
  const identities = new Set();
  source.forEach((rawTool) => {
    const tool = String(rawTool ?? "").trim();
    if (!tool) return;
    const identity = toolIdentity(tool);
    if (identities.has(identity)) return;
    identities.add(identity);
    tools.push(tool);
  });
  return tools;
};

const parseLegacyCoachTools = (rawValue) => Array.isArray(rawValue)
  ? parseCoachTools(rawValue)
  : parseCoachTools(String(rawValue ?? "").split(/\s*;\s*|\r?\n+|,\s+/u));

export const upgradeCoachDraftModel = (candidate, allowLegacyOverflow = false) => {
  const upgraded = clone(candidate);
  const overflowTools = [];
  const legacyRepairs = [];
  if (!Array.isArray(upgraded?.sessions)) return { model: upgraded, overflowTools, legacyRepairs };
  upgraded.sessions.forEach((session) => {
    if (!Array.isArray(session?.rows)) return;
    const rowsByExercise = new Map();
    session.rows.forEach((row) => {
      const parsedTools = allowLegacyOverflow
        ? parseLegacyCoachTools(row.tools)
        : parseCoachTools(row.tools);
      if (parsedTools.length > MAX_TOOLS_PER_EXERCISE) {
        if (!allowLegacyOverflow) throw new Error("Le brouillon courant dépasse la limite d'outils");
        overflowTools.push({
          sessionId: String(session.id ?? ""),
          rowId: String(row.id ?? ""),
          tools: parsedTools.slice(MAX_TOOLS_PER_EXERCISE)
        });
        row.tools = parsedTools.slice(0, MAX_TOOLS_PER_EXERCISE);
      } else {
        row.tools = parsedTools;
      }
      if (!Object.hasOwn(row, "technique")) row.technique = "";
      const rows = rowsByExercise.get(row.plannedExerciseId) ?? [];
      rows.push(row);
      rowsByExercise.set(row.plannedExerciseId, rows);
    });

    rowsByExercise.forEach((rows, plannedExerciseId) => {
      const exerciseFields = ["tools", "tempo", "restSeconds"];
      const canonicalValues = {};
      const conflictingFields = [];
      exerciseFields.forEach((field) => {
        const variants = new Map();
        rows.forEach((row, index) => {
          const identity = field === "tools"
            ? JSON.stringify(row.tools.map(toolIdentity))
            : JSON.stringify(row[field]);
          const variant = variants.get(identity) ?? { value: clone(row[field]), count: 0, firstIndex: index };
          variant.count += 1;
          variants.set(identity, variant);
        });
        canonicalValues[field] = [...variants.values()]
          .sort((left, right) => right.count - left.count || left.firstIndex - right.firstIndex)[0]?.value;
        if (variants.size > 1) conflictingFields.push(field);
      });
      const ranksConflict = rows.some((row, index) => row.setRank !== index + 1);
      if (conflictingFields.length === 0 && !ranksConflict) return;
      if (!allowLegacyOverflow) {
        throw new Error("Le brouillon courant contient un exercice incohérent");
      }
      legacyRepairs.push({
        sessionId: String(session.id ?? ""),
        plannedExerciseId: String(plannedExerciseId ?? ""),
        reasons: [...conflictingFields, ranksConflict ? "setRank" : null].filter(Boolean),
        rows: rows.map((row) => ({
          rowId: String(row.id ?? ""),
          tools: clone(row.tools),
          setRank: row.setRank,
          tempo: row.tempo,
          restSeconds: row.restSeconds
        }))
      });
      rows.forEach((row, index) => {
        exerciseFields.forEach((field) => {
          row[field] = clone(canonicalValues[field]);
        });
        row.setRank = index + 1;
      });
    });
  });
  return { model: upgraded, overflowTools, legacyRepairs };
};

const normalizeCoachTools = (rawValue) => {
  const tools = parseCoachTools(rawValue);
  if (tools.length > MAX_TOOLS_PER_EXERCISE) {
    throw new Error(`Un exercice accepte ${MAX_TOOLS_PER_EXERCISE} outils au maximum`);
  }
  return tools;
};

export const coachValuesEqual = (left, right) => {
  if (!Array.isArray(left) && !Array.isArray(right)) return Object.is(left, right);
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
};

export const normalizeCoachValue = (field, rawValue) => {
  const raw = typeof rawValue === "string" ? rawValue.trim() : rawValue;
  if (field === "tools") return normalizeCoachTools(rawValue);
  if (field === "technique") return String(raw ?? "");
  if (field === "targetRir") {
    if (raw === "" || raw === null) return null;
    const value = Number(String(raw).replace(",", "."));
    if (!Number.isFinite(value) || value < 0 || value > 10 || !Number.isInteger(value * 2)) {
      throw new Error("Le RIR doit être compris entre 0 et 10, par pas de 0,5");
    }
    return value;
  }
  if (field === "setRank") {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) throw new Error("Le rang de série doit être un entier positif");
    return value;
  }
  if (field === "restSeconds") {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 900) {
      throw new Error("Le repos doit être un entier entre 0 et 900 secondes");
    }
    return value;
  }
  if (field === "targetReps") {
    const match = String(raw).match(/^(\d+)\s*(?:[-–]\s*(\d+))?$/u);
    if (!match) throw new Error("Les répétitions doivent ressembler à 8–10 ou 12");
    if (match[2] && Number(match[1]) > Number(match[2])) {
      throw new Error("La borne minimale de répétitions ne peut pas dépasser la borne maximale");
    }
    return match[2] ? `${match[1]}–${match[2]}` : match[1];
  }
  if (field === "tempo") {
    if (raw === "Hérité") return raw;
    if (!/^\d+-\d+-\d+-\d+$/u.test(String(raw))) throw new Error("Le tempo attendu contient quatre phases");
    return String(raw);
  }
  if (["groupLabel", "exerciseName"].includes(field)) {
    if (field === "exerciseName" && String(raw).length === 0) throw new Error("Le nom de l'exercice est obligatoire");
    if (field === "groupLabel" && String(raw).length === 0) throw new Error("Le libellé du groupe est obligatoire");
    return String(raw);
  }
  throw new Error(`Champ non modifiable : ${field}`);
};

export const updateCoachCell = (model, sessionId, rowId, field, rawValue) => {
  const next = clone(model);
  const session = next.sessions.find((candidate) => candidate.id === sessionId);
  const row = session?.rows.find((candidate) => candidate.id === rowId);
  if (!row) throw new Error("Cellule introuvable");
  if (field === "setRank") throw new Error("Le numéro de série est calculé par l'ordre des lignes");
  const normalized = normalizeCoachValue(field, rawValue);
  const exerciseLevelFields = new Set(["exerciseName", "tools", "tempo", "restSeconds"]);
  const targets = exerciseLevelFields.has(field)
    ? session.rows.filter((candidate) => candidate.plannedExerciseId === row.plannedExerciseId)
    : field === "groupLabel"
      ? session.rows.filter((candidate) => candidate.groupId === row.groupId)
      : [row];
  targets.forEach((candidate) => {
    candidate[field] = clone(normalized);
  });
  return next;
};

export const rectangularCellIds = (rows, columns, anchor, focus) => {
  const rowA = rows.findIndex((row) => row.id === anchor.rowId);
  const rowB = rows.findIndex((row) => row.id === focus.rowId);
  const columnA = columns.findIndex((column) => column.key === anchor.columnKey);
  const columnB = columns.findIndex((column) => column.key === focus.columnKey);
  if ([rowA, rowB, columnA, columnB].some((index) => index < 0)) return [];
  const [rowStart, rowEnd] = [Math.min(rowA, rowB), Math.max(rowA, rowB)];
  const [columnStart, columnEnd] = [Math.min(columnA, columnB), Math.max(columnA, columnB)];
  const selected = [];
  for (let rowIndex = rowStart; rowIndex <= rowEnd; rowIndex += 1) {
    for (let columnIndex = columnStart; columnIndex <= columnEnd; columnIndex += 1) {
      selected.push(`${rows[rowIndex].id}::${columns[columnIndex].key}`);
    }
  }
  return selected;
};

const rectangleBounds = (session, anchor, focus) => {
  const rowA = session.rows.findIndex((row) => row.id === anchor?.rowId);
  const rowB = session.rows.findIndex((row) => row.id === focus?.rowId);
  const columnA = COACH_COLUMNS.findIndex((column) => column.key === anchor?.columnKey);
  const columnB = COACH_COLUMNS.findIndex((column) => column.key === focus?.columnKey);
  if ([rowA, rowB, columnA, columnB].some((index) => index < 0)) {
    throw new Error("La sélection ne correspond pas à la grille active");
  }
  return {
    rowStart: Math.min(rowA, rowB),
    rowEnd: Math.max(rowA, rowB),
    columnStart: Math.min(columnA, columnB),
    columnEnd: Math.max(columnA, columnB)
  };
};

export const copyCoachRectangle = (model, sessionId, anchor, focus) => {
  const session = model.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error("Séance introuvable");
  const bounds = rectangleBounds(session, anchor, focus);
  const values = [];
  for (let rowIndex = bounds.rowStart; rowIndex <= bounds.rowEnd; rowIndex += 1) {
    const rowValues = [];
    for (let columnIndex = bounds.columnStart; columnIndex <= bounds.columnEnd; columnIndex += 1) {
      rowValues.push(clone(session.rows[rowIndex][COACH_COLUMNS[columnIndex].key]));
    }
    values.push(rowValues);
  }
  return {
    kind: "jbm-coach-rectangle",
    version: 1,
    rowCount: bounds.rowEnd - bounds.rowStart + 1,
    columnCount: bounds.columnEnd - bounds.columnStart + 1,
    columnKeys: COACH_COLUMNS
      .slice(bounds.columnStart, bounds.columnEnd + 1)
      .map((column) => column.key),
    values
  };
};

const validateCoachClipboard = (clipboard) => {
  const valid = clipboard?.kind === "jbm-coach-rectangle"
    && clipboard.version === 1
    && Number.isInteger(clipboard.rowCount)
    && clipboard.rowCount > 0
    && Number.isInteger(clipboard.columnCount)
    && clipboard.columnCount > 0
    && Array.isArray(clipboard.values)
    && clipboard.values.length === clipboard.rowCount
    && clipboard.values.every((row) => Array.isArray(row) && row.length === clipboard.columnCount);
  if (!valid) throw new Error("Le presse-papiers interne est invalide");
};

export const pasteCoachRectangle = (model, sessionId, target, clipboard) => {
  validateCoachClipboard(clipboard);
  const session = model.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error("Séance introuvable");
  const targetRowIndex = session.rows.findIndex((row) => row.id === target?.rowId);
  const targetColumnIndex = COACH_COLUMNS.findIndex((column) => column.key === target?.columnKey);
  if (targetRowIndex < 0 || targetColumnIndex < 0) throw new Error("Cellule de destination introuvable");
  const lastRowIndex = targetRowIndex + clipboard.rowCount - 1;
  const lastColumnIndex = targetColumnIndex + clipboard.columnCount - 1;
  if (lastRowIndex >= session.rows.length || lastColumnIndex >= COACH_COLUMNS.length) {
    throw new Error("Le rectangle copié dépasse la grille à partir de cette cellule");
  }

  const exerciseLevelFields = new Set(["exerciseName", "tools", "tempo", "restSeconds"]);
  const coherentValues = new Map();
  const assignments = [];
  let preservedStructuralCellCount = 0;
  for (let rowOffset = 0; rowOffset < clipboard.rowCount; rowOffset += 1) {
    const row = session.rows[targetRowIndex + rowOffset];
    for (let columnOffset = 0; columnOffset < clipboard.columnCount; columnOffset += 1) {
      const field = COACH_COLUMNS[targetColumnIndex + columnOffset].key;
      if (field === "setRank") {
        preservedStructuralCellCount += 1;
        continue;
      }
      const value = normalizeCoachValue(field, clipboard.values[rowOffset][columnOffset]);
      assignments.push({ rowId: row.id, field, value });

      const scope = field === "groupLabel"
        ? { key: `group:${row.groupId}:${field}`, label: "groupe" }
        : exerciseLevelFields.has(field)
          ? { key: `exercise:${row.plannedExerciseId}:${field}`, label: "exercice" }
          : null;
      if (!scope) continue;
      if (coherentValues.has(scope.key) && !coachValuesEqual(coherentValues.get(scope.key).value, value)) {
        throw new Error(`Le collage contient des valeurs différentes pour le même ${scope.label} dans la colonne ${field}`);
      }
      coherentValues.set(scope.key, { value });
    }
  }

  if (assignments.length === 0) {
    throw new Error("La colonne Série est calculée et ne peut pas être remplacée par collage");
  }

  let next = clone(model);
  assignments.forEach((assignment) => {
    next = updateCoachCell(next, sessionId, assignment.rowId, assignment.field, assignment.value);
  });
  const nextSession = next.sessions.find((candidate) => candidate.id === sessionId);
  const beforeById = new Map(session.rows.map((row) => [row.id, row]));
  const changedRowCount = nextSession.rows.filter((row) => {
    const before = beforeById.get(row.id);
    return COACH_COLUMNS.some((column) => !coachValuesEqual(before?.[column.key], row[column.key]));
  }).length;
  return {
    model: next,
    pastedCellCount: assignments.length,
    preservedStructuralCellCount,
    changedRowCount,
    destinationAnchor: {
      rowId: session.rows[targetRowIndex].id,
      columnKey: COACH_COLUMNS[targetColumnIndex].key
    },
    destinationFocus: {
      rowId: session.rows[lastRowIndex].id,
      columnKey: COACH_COLUMNS[lastColumnIndex].key
    }
  };
};

export const applyBulkEdit = (model, sessionId, cellIds, field, rawValue) => {
  const next = clone(model);
  const session = next.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error("Séance introuvable");
  const rowIds = new Set(cellIds.map((cellId) => cellId.slice(0, cellId.lastIndexOf("::"))));
  const normalized = normalizeCoachValue(field, rawValue);
  const coherentRowIds = new Set(rowIds);
  if (["tools", "tempo", "restSeconds"].includes(field)) {
    const selectedExerciseIds = new Set(
      session.rows.filter((row) => rowIds.has(row.id)).map((row) => row.plannedExerciseId)
    );
    session.rows.forEach((row) => {
      if (selectedExerciseIds.has(row.plannedExerciseId)) coherentRowIds.add(row.id);
    });
  }
  let changed = 0;
  let matched = 0;
  for (const row of session.rows) {
    if (coherentRowIds.has(row.id)) {
      matched += 1;
      if (coachValuesEqual(row[field], normalized)) continue;
      row[field] = clone(normalized);
      changed += 1;
    }
  }
  if (matched === 0) throw new Error("La sélection ne contient aucune ligne");
  return { model: next, changed };
};

const PASTE_COLUMNS = [
  "groupLabel",
  "exerciseName",
  "tools",
  "setRank",
  "targetReps",
  "targetRir",
  "tempo",
  "restSeconds",
  "technique"
];

const LEGACY_PASTE_COLUMN_COUNT = PASTE_COLUMNS.length - 1;

export const parseSpreadsheetPaste = (text) => {
  const lines = String(text).replace(/\r/gu, "").split("\n").filter((line) => line.trim().length > 0);
  const accepted = [];
  const rejected = [];
  lines.forEach((line, index) => {
    const cells = line.split("\t");
    if (![LEGACY_PASTE_COLUMN_COUNT, PASTE_COLUMNS.length].includes(cells.length)) {
      rejected.push({
        line: index + 1,
        raw: line,
        reason: `8 ou 9 colonnes attendues, ${cells.length} reçues`
      });
      return;
    }
    try {
      const compatibleCells = cells.length === LEGACY_PASTE_COLUMN_COUNT ? [...cells, ""] : cells;
      const values = Object.fromEntries(PASTE_COLUMNS.map((field, cellIndex) => [
        field,
        normalizeCoachValue(field, compatibleCells[cellIndex])
      ]));
      accepted.push({ line: index + 1, raw: line, values });
    } catch (error) {
      rejected.push({ line: index + 1, raw: line, reason: error.message });
    }
  });
  const exerciseNamesByGroup = new Map();
  accepted.forEach((entry) => {
    const names = exerciseNamesByGroup.get(entry.values.groupLabel) ?? new Set();
    names.add(entry.values.exerciseName);
    exerciseNamesByGroup.set(entry.values.groupLabel, names);
  });
  const ambiguousGroups = new Set(
    [...exerciseNamesByGroup.entries()]
      .filter(([, names]) => names.size > 1)
      .map(([groupLabel]) => groupLabel)
  );
  const unambiguous = [];
  accepted.forEach((entry) => {
    if (!ambiguousGroups.has(entry.values.groupLabel)) {
      unambiguous.push(entry);
      return;
    }
    rejected.push({
      line: entry.line,
      raw: entry.raw,
      reason: `Le groupe ${entry.values.groupLabel || "sans libellé"} contient plusieurs exercices sans type explicite`
    });
  });
  const entriesByExercise = new Map();
  unambiguous.forEach((entry) => {
    const key = `${entry.values.groupLabel}::${entry.values.exerciseName}`;
    const entries = entriesByExercise.get(key) ?? [];
    entries.push(entry);
    entriesByExercise.set(key, entries);
  });
  const incoherentExerciseKeys = new Map();
  entriesByExercise.forEach((entries, key) => {
    const first = entries[0]?.values;
    for (const field of ["tools", "tempo", "restSeconds"]) {
      if (entries.some((entry) => !coachValuesEqual(entry.values[field], first[field]))) {
        incoherentExerciseKeys.set(key, field);
        break;
      }
    }
  });
  const coherent = [];
  unambiguous.forEach((entry) => {
    const key = `${entry.values.groupLabel}::${entry.values.exerciseName}`;
    const incoherentField = incoherentExerciseKeys.get(key);
    if (!incoherentField) {
      coherent.push(entry);
      return;
    }
    rejected.push({
      line: entry.line,
      raw: entry.raw,
      reason: `Les lignes de ${entry.values.exerciseName} utilisent des valeurs différentes pour ${incoherentField}`
    });
  });
  const invalidSeriesKeys = new Set(
    [...entriesByExercise.entries()]
      .filter(([key, entries]) => !incoherentExerciseKeys.has(key)
        && entries.some((entry, index) => entry.values.setRank !== index + 1))
      .map(([key]) => key)
  );
  const structured = [];
  coherent.forEach((entry) => {
    const key = `${entry.values.groupLabel}::${entry.values.exerciseName}`;
    if (!invalidSeriesKeys.has(key)) {
      structured.push(entry);
      return;
    }
    rejected.push({
      line: entry.line,
      raw: entry.raw,
      reason: `Les séries de ${entry.values.exerciseName} doivent former la suite 1, 2, 3… sans doublon`
    });
  });
  return { accepted: structured, rejected, total: lines.length };
};

export const applySpreadsheetPaste = (model, sessionId, preview) => {
  const next = clone(model);
  const session = next.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error("Séance introuvable");
  const allRows = next.sessions.flatMap((candidate) => candidate.rows);
  let importOrdinal = 1;
  const ordinalIsUsed = (ordinal) => allRows.some((row) => (
    String(row.id).startsWith(`coach-row:paste:${ordinal}:`)
      || String(row.plannedSetId).startsWith(`paste-set:${ordinal}:`)
      || String(row.plannedExerciseId).startsWith(`paste-exercise:${ordinal}:`)
      || String(row.groupId).startsWith(`paste-group:${ordinal}:`)
  ));
  while (ordinalIsUsed(importOrdinal)) importOrdinal += 1;
  const exerciseIds = new Map();
  const exerciseRanks = new Map();
  const groupIds = new Map();
  preview.accepted.forEach((entry, index) => {
    const key = `${entry.values.groupLabel}::${entry.values.exerciseName}`;
    if (!exerciseIds.has(key)) exerciseIds.set(key, `paste-exercise:${importOrdinal}:${exerciseIds.size + 1}`);
    const setRank = (exerciseRanks.get(key) ?? 0) + 1;
    exerciseRanks.set(key, setRank);
    if (!groupIds.has(entry.values.groupLabel)) {
      groupIds.set(entry.values.groupLabel, `paste-group:${importOrdinal}:${groupIds.size + 1}`);
    }
    session.rows.push({
      id: `coach-row:paste:${importOrdinal}:${index + 1}`,
      plannedSetId: `paste-set:${importOrdinal}:${index + 1}`,
      plannedExerciseId: exerciseIds.get(key),
      groupId: groupIds.get(entry.values.groupLabel),
      groupType: "simple",
      ...entry.values,
      setRank
    });
  });
  return next;
};

const plannedSetsWithExercise = (fixture) => fixture.program.session.exercises.flatMap((exercise) => (
  exercise.sets.map((set) => ({ exercise, set }))
));

export const resolveSeriesInput = (currentSetLog, previousPerformance) => {
  if (currentSetLog) {
    return {
      reps: currentSetLog.reps,
      loadKg: currentSetLog.loadKg,
      rir: currentSetLog.rir,
      source: "currentSetLog"
    };
  }
  if (previousPerformance) {
    return {
      ...clone(previousPerformance.prefill),
      source: "previousPerformance"
    };
  }
  return { reps: null, loadKg: null, rir: null, source: "empty" };
};

export const buildClientPrototype = (fixture) => {
  const catalog = catalogById(fixture);
  const currentWorkout = fixture.workoutSnapshot.logs.find((workout) => workout.status === "in_progress");
  const previousBySet = new Map(
    fixture.uiScenarios.previousPerformance.map((entry) => [entry.plannedSetId, entry])
  );
  const currentBySet = new Map(currentWorkout.setLogs.map((entry) => [entry.plannedSetId, entry]));
  const groups = new Map(fixture.program.session.groups.map((group) => [group.id, group]));
  const exercises = fixture.program.session.exercises.map((plannedExercise) => {
    const exercise = catalog.get(plannedExercise.catalogExerciseId);
    const group = groups.get(plannedExercise.groupId);
    return {
      id: plannedExercise.id,
      label: plannedExercise.label,
      name: exercise.name,
      groupId: group.id,
      groupLabel: group.label,
      groupType: group.type,
      restSeconds: plannedExercise.restSeconds,
      tempo: tempoLabel(plannedExercise.tempo),
      sets: plannedExercise.sets.map((set) => {
        const current = currentBySet.get(set.id) ?? null;
        const previous = previousBySet.get(set.id) ?? null;
        return {
          id: set.id,
          rank: set.rank,
          targetReps: `${set.targetRepsMin}–${set.targetRepsMax}`,
          targetRir: set.targetRir,
          previousDisplay: previous?.display ?? "—",
          values: resolveSeriesInput(current, previous),
          currentSetLogId: current?.id ?? null,
          isPersisted: current !== null,
          savedAt: null
        };
      })
    };
  });
  return {
    fixtureId: fixture.fixtureId,
    workoutId: currentWorkout.id,
    occurrenceDate: currentWorkout.occurrenceDate,
    status: currentWorkout.status,
    sessionName: fixture.program.session.name,
    coachNote: "Garde une exécution contrôlée et une répétition en réserve sur les dernières séries.",
    coachNoteIsPrototypeOnly: true,
    exercises,
    indicators: clone(currentWorkout.indicators),
    comment: currentWorkout.note,
    savedSetLogCount: currentWorkout.setLogs.length
  };
};

export const saveClientSet = (model, plannedSetId, input, savedAt = new Date().toISOString()) => {
  const next = clone(model);
  const set = next.exercises.flatMap((exercise) => exercise.sets).find((candidate) => candidate.id === plannedSetId);
  if (!set) throw new Error("Série introuvable");
  const normalizeOptionalNumber = (value, label, { integer = false } = {}) => {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (text === "") return null;
    const parsed = Number(text.replace(",", "."));
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} invalide`);
    if (integer && !Number.isInteger(parsed)) throw new Error(`${label} doit être un entier positif ou nul`);
    return parsed;
  };
  const rir = normalizeOptionalNumber(input.rir, "RIR");
  if (rir !== null && (rir > 10 || !Number.isInteger(rir * 2))) {
    throw new Error("Le RIR doit être compris entre 0 et 10, par pas de 0,5");
  }
  set.values = {
    reps: normalizeOptionalNumber(input.reps, "Répétitions", { integer: true }),
    loadKg: normalizeOptionalNumber(input.loadKg, "Charge"),
    rir,
    source: "currentSetLog"
  };
  if (!set.isPersisted) next.savedSetLogCount += 1;
  set.isPersisted = true;
  set.currentSetLogId = set.currentSetLogId ?? `prototype-set-log:${model.workoutId}:${plannedSetId}`;
  set.savedAt = savedAt;
  return next;
};

export const serializeClientPrototype = (model) => JSON.stringify(model);

export const restoreClientPrototype = (fixture, serialized) => {
  const fresh = buildClientPrototype(fixture);
  if (!serialized) return fresh;
  try {
    const parsed = JSON.parse(serialized);
    if (parsed.fixtureId !== fresh.fixtureId || parsed.workoutId !== fresh.workoutId) return fresh;
    const expectedIds = new Set(fresh.exercises.flatMap((exercise) => exercise.sets.map((set) => set.id)));
    const parsedIds = parsed.exercises.flatMap((exercise) => exercise.sets.map((set) => set.id));
    if (parsedIds.length !== expectedIds.size || parsedIds.some((id) => !expectedIds.has(id))) return fresh;
    if (new Set(parsedIds).size !== parsedIds.length) return fresh;
    if (!["in_progress", "completed", "skipped"].includes(parsed.status)) return fresh;
    const optionalNumber = (value) => value === null
      || (typeof value === "number" && Number.isFinite(value) && value >= 0);
    const optionalInteger = (value) => value === null
      || (optionalNumber(value) && Number.isInteger(value));
    const optionalRir = (value) => value === null
      || (optionalNumber(value) && value <= 10 && Number.isInteger(value * 2));
    const validSources = new Set(["currentSetLog", "previousPerformance", "empty"]);
    const parsedSets = parsed.exercises.flatMap((exercise) => exercise.sets);
    const validSets = parsedSets.every((set) => set.values
      && optionalInteger(set.values.reps)
      && optionalNumber(set.values.loadKg)
      && optionalRir(set.values.rir)
      && validSources.has(set.values.source)
      && typeof set.isPersisted === "boolean"
      && (set.currentSetLogId === null || typeof set.currentSetLogId === "string")
      && (set.savedAt === null || typeof set.savedAt === "string"));
    if (!validSets) return fresh;
    parsed.savedSetLogCount = parsedSets.filter((set) => set.isPersisted).length;
    return parsed;
  } catch {
    return fresh;
  }
};

export const timingResult = (startedAtMs, completedAtMs, maximumSeconds) => {
  const elapsedSeconds = Math.max(0, (completedAtMs - startedAtMs) / 1000);
  return {
    elapsedSeconds,
    maximumSeconds,
    passed: elapsedSeconds <= maximumSeconds
  };
};

export const countClientSetLogs = (model) => model.exercises
  .flatMap((exercise) => exercise.sets)
  .filter((set) => set.isPersisted)
  .length;

export const getPlannedSetCount = (fixture) => plannedSetsWithExercise(fixture).length;
