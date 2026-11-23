"use client";

import { SearchFilters, type SearchFiltersProps, type TableData } from "@chtc/web-components";
import { FilterList } from "@mui/icons-material";
import { Button, Popover } from "@mui/material";
import { useState } from "react";

export const FilterButton = <R extends TableData>(props: SearchFiltersProps<R>) => {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  return (
    <>
      <Button variant="field" startIcon={<FilterList />} onClick={(e) => setAnchor(e.currentTarget)}>
        Filter
      </Button>
      <Popover
        open={anchor !== null}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        // Opens beside the button, top edges lined up
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        slotProps={{ paper: { sx: { ml: 1 } } }}
      >
        <SearchFilters {...props} />
      </Popover>
    </>
  );
};

export default FilterButton;
