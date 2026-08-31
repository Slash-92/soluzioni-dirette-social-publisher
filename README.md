# Soluzioni Dirette — automazione Notion → Buffer

Questa cartella è la root del repository pubblico separato che ospita solo i
media approvati e il motore di pubblicazione di Soluzioni Dirette.

Il workflow principale è `.github/workflows/notion-buffer-sync.yml`. Legge il
database Notion dedicato, scarica gli allegati approvati, li espone tramite
GitHub Pages e programma Instagram e Facebook su Buffer. Le Story vengono
programmate come frame separati, distanziati di un minuto.

## Flusso automatico in due fasi

### 1. Notion → GitHub Pages

I media vengono copiati automaticamente da Notion nel repository e pubblicati
su GitHub Pages quando sono vere queste condizioni:

- `Brand` uguale a `Soluzioni Dirette`;
- `Grafica pronta`, `Caption pronta` e `Pronto per pubblicazione` selezionati;
- file SVG/PNG allegati nella proprietà `Media`;
- `URL media pubblici` ancora vuoto.

Per questa fase non servono ancora data, canali o stato `Da programmare`. Il
workflow `notion-media-sync.yml` controlla Notion ogni ora, scarica i
file, li salva in `media/notion`, esegue il commit automatico e scrive in Notion
gli URL pubblici generati da GitHub Pages. Il Mac personale non deve essere
acceso.

### 2. GitHub Pages → Buffer

La programmazione parte solo quando, oltre agli URL pubblici già pronti, sono
presenti:

- `Stato pubblicazione` uguale a `Da programmare`;
- data con ora, caption, formato e canali;
- nessun `Buffer IDs` già creato.

In questo modo approvare e allegare una grafica la rende disponibile su GitHub,
ma non la manda prematuramente nella coda Buffer.

Le nuove pubblicazioni vengono create in Buffer soltanto quando entrano nella
finestra dei 10 giorni precedenti la data prevista. Prima di creare un post,
l'automazione legge la coda reale di ogni canale e mantiene una soglia di 9
elementi su 10: il decimo slot resta libero come margine di sicurezza. Un
carosello occupa uno slot per canale; una Story occupa uno slot per ciascun
frame. Se l'intero contenuto non entra su tutti i canali selezionati, resta in
Notion con stato `Da programmare` e viene riprovato al passaggio successivo.

Non aggiungere credenziali ai file. Le chiavi restano esclusivamente nei GitHub
Actions Secrets. `.env` è riservato a eventuali test locali ed è escluso da Git.

La fase Buffer viene eseguita automaticamente una volta al giorno alle 07:15,
fuso `Europe/Rome`, ed è disponibile anche manualmente. Prima di creare una
pubblicazione verifica con una richiesta reale che ogni URL GitHub Pages abbia
un MIME immagine/video valido e un corpo non vuoto. Il workflow `pages.yml`
pubblica i media dopo ogni commit che aggiunge nuovi file.
