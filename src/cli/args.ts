import { parseArgs, type ParseArgsOptionsConfig } from "util";
import { die } from "./fmt";

/** `util.parseArgs`, strict, with its error turned into a clean CLI message. Generic so option types survive. */
export function opts<const T extends ParseArgsOptionsConfig>(argv: string[], options: T) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (err: any) {
    die(err.message);
  }
}
