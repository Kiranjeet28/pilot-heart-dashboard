import type { ReactNode } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "./panel";

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
}

export function RegistryTable<T extends { id: string }>({
  rows,
  columns,
  onEdit,
  onDelete,
  emptyTitle,
}: {
  rows: T[];
  columns: Column<T>[];
  onEdit: (r: T) => void;
  onDelete: (r: T) => void;
  emptyTitle: string;
}) {
  if (!rows.length)
    return <EmptyState title={emptyTitle} hint="Use the Add button to create one." />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((c) => (
            <TableHead key={c.header} className={c.className}>
              {c.header}
            </TableHead>
          ))}
          <TableHead className="w-24 text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            {columns.map((c) => (
              <TableCell key={c.header} className={c.className}>
                {c.cell(r)}
              </TableCell>
            ))}
            <TableCell className="text-right">
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Edit ${r.id}`}
                onClick={() => onEdit(r)}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Delete ${r.id}`}
                onClick={() => onDelete(r)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
