// Placeholder so the test pool can bind the ArtifactRuntime DO; the real class lands with the runtime tasks.
export class ArtifactRuntime {
  fetch(): Response {
    return new Response("ArtifactRuntime placeholder", { status: 501 });
  }
}
