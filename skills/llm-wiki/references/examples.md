# Worked examples

Concrete output shapes for ingest and query operations. Match these formats when
writing pages, index entries, and log lines.

## Ingest

### Log entry

```markdown
## [2024-06-10] ingest | Attention Is All You Need (Vaswani et al. 2017)
Pages created: transformer-attention. Pages updated: bert, self-attention. New links: 3. Missing pages flagged: 0.
```

### Wiki page — `tech/transformer-attention.md`

```markdown
# Transformer Attention

Scaled dot-product attention computes Q·Kᵀ/√d_k before softmax. Multi-head
attention runs h parallel heads then concatenates. ([source: vaswani-2017.pdf])

## Related
- [[self-attention]] — single-sequence variant
- [[bert]] — applies bidirectional self-attention for masked-LM pretraining
```

### Matching `index.md` entry

```markdown
- [transformer-attention](tech/transformer-attention.md) — scaled dot-product & multi-head attention mechanism (ML, architecture)
```

## Query

### Log entry

```markdown
## [2024-06-11] query | How does BERT use attention?
Pages read: bert, transformer-attention, self-attention. Pages created: tech/bert-attention-usage. Citations: 2. Missing pages flagged: 0.
```

### Query page — `tech/bert-attention-usage.md`

```markdown
# How Does BERT Use Attention?

BERT uses **bidirectional self-attention**: every token attends to every other
token in the sequence (subject only to padding masks). During masked-LM
pretraining, ~15% of input tokens are replaced with `[MASK]` and the encoder
must predict them from the surrounding bidirectional context. It inherits the
multi-head mechanism from the Transformer encoder
([transformer-attention](transformer-attention.md)), running 12 heads in the
base model. ([source: bert.md, transformer-attention.md])

## Related
- [[transformer-attention]] — underlying attention mechanism
- [[self-attention]] — single-sequence variant BERT specialises
```
