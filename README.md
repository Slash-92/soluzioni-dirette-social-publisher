# Soluzioni Dirette — automazione Notion → Buffer

Questa cartella è la root del repository pubblico separato che ospita solo i
media approvati e il motore di pubblicazione di Soluzioni Dirette.

Il workflow principale è `.github/workflows/notion-buffer-sync.yml`. Legge il
database Notion dedicato, scarica gli allegati approvati, li espone tramite
GitHub Pages e programma Instagram e Facebook su Buffer. Le Story vengono
programmate come frame separati, distanziati di un minuto.

## Regola di ingresso

Un contenuto entra nel flusso solo quando sono vere tutte queste condizioni:

- `Brand` uguale a `Soluzioni Dirette`;
- `Grafica pronta`, `Caption pronta` e `Pronto per pubblicazione` selezionati;
- `Stato pubblicazione` uguale a `Da programmare`;
- data con ora, caption, formato, canali e media presenti;
- nessun `Buffer IDs` già creato.

Il primo passaggio copia i media da Notion nel repository. Un passaggio
successivo verifica gli URL pubblici e crea le programmazioni Buffer senza
duplicati.

Le nuove pubblicazioni vengono create in Buffer soltanto quando entrano nella
finestra dei 10 giorni precedenti la data prevista.

Non aggiungere credenziali ai file. Le chiavi restano esclusivamente nei GitHub
Actions Secrets. `.env` è riservato a eventuali test locali ed è escluso da Git.

Durante il collaudo la sincronizzazione Notion resta solo manuale. Il workflow
`pages.yml` pubblica invece i media approvati su GitHub Pages al primo push e
dopo ogni sincronizzazione completata.
