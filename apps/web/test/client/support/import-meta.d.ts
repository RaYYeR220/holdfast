/**
 * What the test runner adds to `import.meta`: the modules matching a pattern,
 * loaded before the importing module runs. Only the form used here is declared.
 */
interface ImportMeta {
  glob<Module>(pattern: string, options: { eager: true }): Record<string, Module>;
}
