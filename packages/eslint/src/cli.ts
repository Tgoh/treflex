#!/usr/bin/env node
import process from "node:process";
import ts from "typescript";
import { main } from "./nameCommand";

process.exitCode = main(ts.sys.args, ts.sys);
