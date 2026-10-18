// The slice of vite/client's types we use; vite isn't a direct dependency.
interface ImportMeta {
  readonly env?: { readonly DEV?: boolean };
}
