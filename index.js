async function fetch(request, env, ctx) {
    const nowFn = () => new Date();
    const uuidFn = () => crypto.randomUUID();
    const GEMINI_API_KEY = env.GEMINI_API_KEY;
}
