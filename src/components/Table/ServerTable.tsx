"use client";

import { apiFetch } from "@/src/components/AuthProvider";
import { apiErrorMessage } from "@/src/utils/formErrors";
import useDebounce from "@/src/utils/useDebounce";
import FilterButton from "@/src/components/Table/FilterButton/FilterButton";
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_PAGE_SIZE_OPTIONS,
  FILTER_OPERATORS,
  Table,
  type ActionConfig,
  type DisplayColumn,
  type Filter,
  type FilterComponent,
  type SortState,
  type TableData,
} from "@chtc/web-components";
import { Alert, Box, LinearProgress, TextField, Typography } from "@mui/material";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";

// Sorting and filtering happen on the server, so columns are sorted by id and filtered through the API
export interface ServerColumnConfig<R extends TableData> extends DisplayColumn<R> {
  sortable?: boolean;
  firstSortDirection?: SortState["direction"];
  FilterComponent?: FilterComponent;
  /** The API field to filter on, when it isn't the column id */
  filterField?: string;
}

export type ServerTableColumns<R extends TableData> = Record<string, ServerColumnConfig<R> | ActionConfig<R>>;

export interface ServerTableProps<R extends TableData> {
  endpoint: string;
  columns: ServerTableColumns<R>;
  defaultSort?: SortState<keyof R & string>;
  tiebreakers?: SortState[];
  defaultPageSize?: number;
  urlPrefix?: string; // used when theres more than one table per page
  searchLabel?: string;
  searchFields?: string[]; // not case sensitive
  emptyMessage?: string;
}

interface TableQuery {
  page: number;
  pageSize: number;
  sort?: SortState;
  search: string;
  filters: Filter[];
}

interface TablePage<R> {
  data: R[];
  totalCount: number;
}

type ParamSource = Pick<URLSearchParams, "get" | "keys">;

const isServerTableKey = (endpoint: string) => (key: unknown) => Array.isArray(key) && key[0] === endpoint;

export function useServerTableRefresh(endpoint: string) {
  const { mutate } = useSWRConfig();
  return useCallback(() => mutate(isServerTableKey(endpoint)), [mutate, endpoint]);
}

const ServerTable = <R extends TableData>(props: ServerTableProps<R>) => {
  // Reading URL params needs a Suspense boundary for static export
  return (
    <Suspense fallback={<LinearProgress />}>
      <ServerTableContent {...props} />
    </Suspense>
  );
};

const ServerTableContent = <R extends TableData>({
  endpoint,
  columns,
  defaultSort,
  tiebreakers,
  defaultPageSize = DEFAULT_PAGE_SIZE,
  urlPrefix = "",
  searchLabel,
  searchFields,
  emptyMessage = "No results",
}: ServerTableProps<R>) => {
  const searchParams = useSearchParams();

  const keys = useMemo(
    () => ({
      page: `${urlPrefix}page`,
      pageSize: `${urlPrefix}size`,
      sort: `${urlPrefix}sort`,
      search: `${urlPrefix}q`,
      // e.g. "users.cpus.ge"
      filter: ({ id, operator }: Filter) => `${urlPrefix}${id}.${operator}`,
    }),
    [urlPrefix],
  );

  const sortableColumns = useMemo(
    () =>
      Object.values(columns)
        .filter((column) => "sortable" in column && column.sortable)
        .map((column) => column.id),
    [columns],
  );

  const filterColumns = useMemo(
    () =>
      Object.values(columns).flatMap((column) =>
        "FilterComponent" in column && column.FilterComponent
          ? [{ id: column.id, name: column.name, FilterComponent: column.FilterComponent }]
          : [],
      ),
    [columns],
  );

  // Any column can be filtered from the URL, with or without a filter component
  const filterFields = useMemo(
    () =>
      new Map(
        Object.values(columns).map((column) => [
          column.id,
          ("filterField" in column && column.filterField) || column.id,
        ]),
      ),
    [columns],
  );

  const parseFilter = useCallback(
    (key: string, value: string): Filter | undefined => {
      if (!key.startsWith(urlPrefix) || value === "") return undefined;
      const parts = key.slice(urlPrefix.length).split(".");
      if (parts.length !== 2) return undefined;
      const [id, op] = parts;
      const operator = FILTER_OPERATORS.find((o) => o === op);
      return operator && filterFields.has(id) ? { id, operator, value } : undefined;
    },
    [urlPrefix, filterFields],
  );

  const parseQuery = useCallback(
    (params: ParamSource): TableQuery => {
      const page = parseInt(params.get(keys.page) ?? "", 10);
      const pageSize = parseInt(params.get(keys.pageSize) ?? "", 10);

      return {
        page: page >= 1 ? page - 1 : 0,
        pageSize: DEFAULT_PAGE_SIZE_OPTIONS.includes(pageSize) ? pageSize : defaultPageSize,
        sort: parseSort(params.get(keys.sort), sortableColumns) ?? defaultSort,
        search: params.get(keys.search) ?? "",
        // get returns a repeated key's first value
        filters: [...new Set(params.keys())].flatMap((key) => parseFilter(key, params.get(key) ?? "") ?? []),
      };
    },
    [keys, defaultPageSize, defaultSort, sortableColumns, parseFilter],
  );

  const query = useMemo(() => parseQuery(searchParams), [parseQuery, searchParams]);

  const setQuery = useCallback(
    (changes: Partial<TableQuery>) => {
      // Start from the live URL rather than this render's snapshot, so two changes that land
      // before the next render (a debounced search and a filter click, say) don't undo each other
      const params = new URLSearchParams(window.location.search);
      const current = parseQuery(params);
      const next = { ...current, ...changes };

      if (changes.page === undefined) {
        next.page = 0;
      }

      const set = (key: string, value: string | undefined) =>
        value === undefined ? params.delete(key) : params.set(key, value);

      set(keys.page, next.page > 0 ? String(next.page + 1) : undefined);
      set(keys.pageSize, next.pageSize !== defaultPageSize ? String(next.pageSize) : undefined);
      set(keys.sort, next.sort && !sameSort(next.sort, defaultSort) ? formatSort(next.sort) : undefined);
      set(keys.search, next.search || undefined);
      // Other params, including other tables' and unrelated ones, are kept
      current.filters.forEach((filter) => params.delete(keys.filter(filter)));
      next.filters.forEach((filter) => params.append(keys.filter(filter), filter.value));

      const queryString = params.toString();
      const { pathname } = window.location;

      // Table state is client-side only, so update the URL in place; Next keeps useSearchParams in
      // sync with replaceState and doesn't re-run the route (which would reset the page title)
      window.history.replaceState(null, "", queryString ? `${pathname}?${queryString}` : pathname);
    },
    [parseQuery, keys, defaultPageSize, defaultSort],
  );

  const { data, error, isLoading } = useSWR(
    [endpoint, query],
    ([, q]: [string, TableQuery]) => fetchPage<R>(endpoint, q, { tiebreakers, searchFields, filterFields }),
    { keepPreviousData: true },
  );

  // Step back when the page runs past the end, e.g. after deleting the last row on the last page
  useEffect(() => {
    if (!isLoading && data && query.page > 0 && data.data.length === 0 && data.totalCount > 0) {
      setQuery({ page: Math.ceil(data.totalCount / query.pageSize) - 1 });
    }
  }, [isLoading, data, query.page, query.pageSize, setQuery]);

  const tableColumns = useMemo(
    () =>
      Object.values(columns).map((column) => {
        if (!("sortable" in column && column.sortable)) return column;
        const { firstSortDirection = "asc" } = column;
        return {
          ...column,
          // Table shows the sort icon for columns that have a sort key, and the server does the sorting
          sort: undefined,
          onSort: (next: SortState) =>
            setQuery({
              // A newly chosen column starts in its first direction rather than inheriting the old one
              sort:
                next.columnId === query.sort?.columnId
                  ? next
                  : { columnId: next.columnId, direction: firstSortDirection },
            }),
        };
      }),
    [columns, query.sort, setQuery],
  );

  const rows = data?.data ?? [];
  const totalCount = data?.totalCount ?? 0;

  return (
    <Box>
      {(searchLabel || filterColumns.length > 0) && (
        <Box sx={{ display: "flex", gap: 2, mb: 2, flexWrap: "wrap", alignItems: "flex-start" }}>
          {searchLabel && (
            <SearchField label={searchLabel} value={query.search} onChange={(search) => setQuery({ search })} />
          )}
          {filterColumns.length > 0 && (
            <FilterButton
              columnFilters={filterColumns}
              value={query.filters}
              onChange={(filters) => setQuery({ filters })}
            />
          )}
        </Box>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error instanceof Error ? error.message : "Failed to load data"}
        </Alert>
      )}

      <Box sx={{ height: 4 }}>{isLoading && <LinearProgress />}</Box>

      <Table
        data={rows}
        columns={tableColumns}
        sort={query.sort as SortState<keyof R & string> | undefined}
        pagination={
          totalCount > DEFAULT_PAGE_SIZE_OPTIONS[0]
            ? {
                totalCount,
                page: query.page,
                pageSize: query.pageSize,
                onPageChange: (page) => setQuery({ page }),
                onPageSizeChange: (pageSize) => setQuery({ pageSize }),
              }
            : undefined
        }
      />

      {!isLoading && !error && rows.length === 0 && (
        <Typography color="text.secondary" sx={{ p: 2, textAlign: "center" }}>
          {emptyMessage}
        </Typography>
      )}
    </Box>
  );
};

// The API splits an or=(...) group on commas and brackets it with parentheses, so those can't be searched for
const UNSEARCHABLE = /[,()]/;

/**
 * Page fetch helper for translating props and making list requests
 */
async function fetchPage<R extends TableData>(
  endpoint: string,
  query: TableQuery,
  {
    tiebreakers = [],
    searchFields = [],
    filterFields,
  }: { tiebreakers?: SortState[]; searchFields?: string[]; filterFields: Map<string, string> },
): Promise<TablePage<R>> {
  const params = new URLSearchParams({
    page: String(query.page),
    page_size: String(query.pageSize),
  });

  // The API applies sorts in the order they appear, so the chosen sort goes first
  const sortedColumns = new Set<string>();
  [...(query.sort ? [query.sort] : []), ...tiebreakers].forEach(({ columnId, direction }) => {
    if (sortedColumns.has(columnId)) return;
    sortedColumns.add(columnId);
    params.append(columnId, `order_by.${direction}`);
  });

  const search = query.search.replace(new RegExp(UNSEARCHABLE.source, "g"), " ").replace(/\s+/g, " ").trim();
  if (search && searchFields.length > 0) {
    params.append("or", `(${searchFields.map((field) => `${field}.ilike.${search}`).join(",")})`);
  }

  query.filters.forEach(({ id, operator, value }) => {
    params.append(filterFields.get(id) ?? id, `${operator}.${value}`);
  });

  const response = await apiFetch(`${endpoint}?${params}`);
  if (!response.ok) {
    throw new Error(await apiErrorMessage(response, "Failed to load data"));
  }

  return {
    data: await response.json(),
    totalCount: parseInt(response.headers.get("X-Total-Count") ?? "0", 10),
  };
}

// Sorts are written to the URL as the column id, prefixed with "-" when descending
function formatSort(sort: SortState): string {
  return `${sort.direction === "desc" ? "-" : ""}${sort.columnId}`;
}

function parseSort(value: string | null, sortableColumns: string[]): SortState | undefined {
  if (!value) return undefined;
  const direction = value.startsWith("-") ? "desc" : "asc";
  const columnId = value.replace(/^-/, "");
  return sortableColumns.includes(columnId) ? { columnId, direction } : undefined;
}

function sameSort(a: SortState, b: SortState | undefined): boolean {
  return a.columnId === b?.columnId && a.direction === b.direction;
}

const SearchField = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) => {
  const [input, setInput] = useState(value);
  const debounced = useDebounce(input, 300);

  // The debounce effect only runs when the debounced text changes, so it reads the latest
  // value and onChange through a ref instead of listing them as dependencies
  const latest = useRef({ value, onChange });
  useEffect(() => {
    latest.current = { value, onChange };
  }, [value, onChange]);

  // What this field last wrote to the URL, so a URL change it caused doesn't clobber newer typing
  const lastReported = useRef(value);

  useEffect(() => {
    if (debounced !== latest.current.value) {
      lastReported.current = debounced;
      latest.current.onChange(debounced);
    }
  }, [debounced]);

  // The URL changed from elsewhere, e.g. the Back button: show it
  useEffect(() => {
    if (value !== lastReported.current) {
      lastReported.current = value;
      setInput(value);
    }
  }, [value]);

  return (
    <TextField
      label={label}
      size="small"
      value={input}
      onChange={(e) => setInput(e.target.value)}
      helperText={UNSEARCHABLE.test(input) ? "Commas and parentheses are ignored" : undefined}
      sx={{ width: 300 }}
    />
  );
};

export default ServerTable;
