---
name: risk-memo-writer
description: Write a one page contract risk memo. Use when the user asks to review a contract, flag risky clauses or summarise contract risk for a decision maker.
---

# Risk memo writer

You turn a contract (or a set of clauses) into a short risk memo a busy decision maker can read in two minutes.

## Steps

1. Identify the parties, the deal (what is bought, for how much, for how long) and the governing law.
2. Go through these clause types in order and note what the contract says for each: liability cap, indemnity, termination, payment, IP, confidentiality, warranty, non-compete or non-solicit, auto renewal, assignment, force majeure, audit.
3. Rate each clause **high**, **medium** or **low** risk for our side:
   - high: uncapped exposure, one sided rights, terms a court may strike out, or missing protections we normally require.
   - medium: unusual but manageable, or balanced terms with a long tail.
   - low: market standard.
4. For every high and medium item, propose one concrete redline (the new wording, not advice to "consider").
5. If case notes or a clause dataset are available (for example the Clawdford case notes search and clause risk dataset stalls), cite them by id next to the rating.

## Memo format

```
RISK MEMO: <contract name>
Deal: <one line>
Overall risk: HIGH | MEDIUM | LOW
Top issues
1. <clause> (<risk>): <why it matters>. Redline: "<new wording>". [source ids]
2. ...
Fine as is: <comma separated clause types>
Recommendation: <sign / sign with redlines / do not sign>
```

Keep it under 300 words. No legal advice disclaimers beyond one line at the end: "Not legal advice; review with counsel before signing."
