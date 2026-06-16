import type { ReactNode } from "react";
import { PageConnection } from "./pages/PageConnection.tsx";
import { PageStream }     from "./pages/PageStream.tsx";
import { PageWrite }      from "./pages/PageWrite.tsx";
import { PageRR }         from "./pages/PageRR.tsx";
import { PageTests }      from "./pages/PageTests.tsx";

export type TabItem = {
  id: string;
  label: string;
  page: ReactNode;
};

export const tabs: TabItem[] = [
  { id: "connection", label: "Connection", page: <PageConnection /> },
  { id: "stream",     label: "Stream",     page: <PageStream /> },
  { id: "write",      label: "Write",      page: <PageWrite /> },
  { id: "rr",         label: "R/R",        page: <PageRR /> },
  { id: "tests",      label: "Tests",      page: <PageTests /> },
];
