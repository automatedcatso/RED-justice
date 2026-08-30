# Contributing to RED Justice

Thank you for your interest in contributing! This document outlines how to get started and what we're looking for.

## Code of Conduct

We're committed to providing a welcoming and inclusive environment. Please:
- Be respectful and professional
- Report violations to the maintainers
- Welcome newcomers and diverse perspectives

## Getting Started

### Prerequisites
- Node.js 18+ or Bun
- SQLite 3.x (usually included with your OS)
- Ollama (optional, for local AI models)

### Development Setup

```bash
# Clone and install
git clone <repo-url>
cd red-justice
bun install

# Create local environment
cp .env .env.local

# Initialize database
bun run db:push

# Start dev server
bun run dev
```

Visit `http://localhost:3000`.

### Running Tests

```bash
# All tests
bun run test

# Specific test file
bun run test src/lib/investigation/relVocabulary.test.ts

# Watch mode
bun run test --watch
```

### Linting & Type Checking

```bash
# Check types
bun run tsc

# Lint
bun run lint

# Format (if configured)
bun run format
```

---

## What We're Looking For

### High-Priority Areas

1. **Extraction Engine Improvements**
   - Better entity detection patterns
   - New format support (PDF variants, OCR improvements)
   - Performance optimizations for large documents

2. **Graph & Analytics**
   - New graph algorithms (community detection improvements, centrality variants)
   - Performance on large networks (1000+ nodes)
   - Visualization improvements

3. **AI Model Integration**
   - New provider support (OpenAI, Anthropic, Hugging Face models)
   - Better reasoning model support (chain-of-thought, tool use)
   - Improved prompt engineering

4. **Documentation**
   - API documentation (Swagger/OpenAPI)
   - Video tutorials
   - Extraction pipeline walkthroughs

### Medium-Priority Areas

- Bug fixes (see [Issues](../../issues))
- Performance optimizations
- Test coverage improvements
- UI/UX enhancements

---

## Submitting Changes

### Before You Start
1. **Check existing issues**: Search for similar work
2. **Discussion first**: For major changes, open a discussion or issue
3. **Fork the repo**: Create your own branch

### Development Workflow

```bash
# Create a feature branch
git checkout -b feature/your-feature-name

# Make changes (keep commits atomic)
git add .
git commit -m "Brief description of change"

# Ensure tests pass
bun run test
bun run lint
bun run tsc

# Push to your fork
git push origin feature/your-feature-name

# Open a Pull Request
```

### Pull Request Guidelines

- **Title**: Clear, descriptive (e.g., "Add PDF CID text extraction for LibreOffice PDFs")
- **Description**: 
  - What problem does this solve?
  - How did you test it?
  - Any breaking changes?
  - References to related issues
- **Tests**: Include unit/integration tests
- **Docs**: Update README/docs if needed
- **No merge conflicts**: Rebase if necessary

### Commit Messages

Use clear, conventional commits:

```
feat: Add new entity extraction pattern for bank accounts
fix: Resolve timeout on 20K+ char documents
docs: Update EXTRACTION.md with v3.10 reference stitching
perf: Optimize graph layout algorithm by 3x
test: Add edge cases for CDR parsing
refactor: Consolidate relationship vocabulary into single source
```

---

## Code Style

### TypeScript

- Use strict mode (`strict: true` in tsconfig.json)
- Explicit return types on functions
- Avoid `any` (use `unknown` + type narrowing)
- Use `const` by default, `let` when needed

```typescript
// ✅ Good
export function extractPhones(text: string): string[] {
  const pattern = /\+?[\d\-]{10,}/g;
  return text.match(pattern) ?? [];
}

// ❌ Avoid
export function extractPhones(text: any) {
  const pattern = /\+?[\d\-]{10,}/g;
  const result: any = text.match(pattern);
  return result;
}
```

### React Components

- Use functional components with hooks
- Props as a typed interface
- Hooks (useState, useEffect) at the top of component

```typescript
interface MyComponentProps {
  title: string;
  onClose: () => void;
}

export function MyComponent({ title, onClose }: MyComponentProps) {
  const [state, setState] = useState("");
  
  return (
    <div>
      <h1>{title}</h1>
      <button onClick={onClose}>Close</button>
    </div>
  );
}
```

### Naming

- `camelCase` for functions/variables
- `PascalCase` for components/classes
- `UPPER_SNAKE` for constants
- Descriptive names over abbreviations

---

## File Organization

```
src/
├── app/                # Next.js app routes
│   ├── api/           # REST endpoints
│   └── *.tsx          # Pages & layouts
├── components/        # React components
│   ├── red-justice/   # Feature components
│   ├── ui/            # Reusable UI
│   └── benchmark/     # Benchmark Lab
├── lib/               # Core logic
│   ├── extractors/    # File parsing
│   ├── investigation/ # Investigation logic
│   ├── analytics/     # Graph algorithms
│   └── *.ts           # Utilities
├── hooks/             # Custom React hooks
├── types/             # Type definitions
└── instrumentation.ts # Startup
```

---

## Database Changes

If you modify `prisma/schema.prisma`:

```bash
# Create migration
bun run prisma migrate dev --name your_migration_name

# Apply migration
bun run db:push

# Reset database (dev only)
bun run db:push --reset
```

Include the migration file in your PR.

---

## Documentation

- **Code comments**: Explain *why*, not *what* (code shows what)
- **Function docs**: JSDoc for public APIs
- **README updates**: If you add features, update the main README
- **ARCHITECTURE.md**: Update if you change core concepts
- **EXTRACTION.md**: Update if you modify the extraction pipeline

```typescript
/**
 * Extracts phone numbers from text using regex.
 * Handles international formats (+XX-XXXX-XXXXXX) and local sequences (10+ digits).
 * 
 * @param text - The text to search for phone numbers
 * @returns Array of phone numbers found, or empty array if none
 */
export function extractPhones(text: string): string[] {
  // ...
}
```

---

## Asking Questions

- **Confused about architecture?** See [ARCHITECTURE.md](../../ARCHITECTURE.md)
- **Extraction pipeline questions?** See [EXTRACTION.md](../../EXTRACTION.md)
- **Code questions?** Check related tests
- **Stuck?** Open a discussion or comment on the issue

---

## Recognition

Contributors are recognized in:
- Release notes
- CONTRIBUTORS.md (if we have one)
- GitHub's automatic contributors page

Thank you for improving RED Justice! 🙏

---

## License

By contributing, you agree your code will be licensed under the same license as RED Justice (see [LICENSE](../../LICENSE)).
