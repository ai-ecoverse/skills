# SecondHandSongs Reference

SecondHandSongs (SHS) is the definitive database for tracking cover versions, originals, and song genealogies.

## Key Concepts

### Work vs Performance

- **Work**: The underlying song composition (e.g., "Torn" as a musical work)
- **Performance**: A specific recording of a work (e.g., Lis Sørensen's "Brændt", Ednaswap's "Torn", Natalie Imbruglia's "Torn")

A work can have multiple originals (e.g., "Apache" has two originals - Bert Weedon recorded first, The Shadows released first).

### Original Types

SHS defines three types of originals:
1. First recorded
2. First released
3. Written by performer (singer-songwriter original)

## URL Structure

### Direct URLs

```
Work page:        https://secondhandsongs.com/work/{WORK_ID}
Performance page: https://secondhandsongs.com/performance/{PERFORMANCE_ID}
Artist page:      https://secondhandsongs.com/artist/{ARTIST_ID}
```

### Search URLs

```
Search works:        https://secondhandsongs.com/search/work
Search performances: https://secondhandsongs.com/search/performance
Search artists:      https://secondhandsongs.com/search/artist
```

### Browse URLs

```
Explore (recent covers): https://secondhandsongs.com/explore
Statistics:              https://secondhandsongs.com/statistics
Most covered songs:      https://secondhandsongs.com/statistics (scroll to lists)
```

## API Access (Beta)

The API is RESTful. To get JSON instead of HTML, set the Accept header:

```
Accept: application/json
```

### Search Endpoints

```
GET /search/work?title={TITLE}
GET /search/performance?title={TITLE}&performer={ARTIST}
GET /search/artist?commonName={NAME}
```

### Resource Endpoints

```
GET /work/{ID}          → Work details with all performances
GET /performance/{ID}   → Performance details with original/cover info
GET /artist/{ID}        → Artist details with discography
```

## Web Browsing Strategy

When API access is unavailable, browse the website:

1. **Find a song's genealogy**:
   - Search for the famous version at `/search/performance`
   - Navigate to its work page to see all versions
   - Look for "Original" badges and release dates

2. **Find foreign adaptations**:
   - On a work page, filter performances by language
   - Look for versions with different titles (translations)

3. **Discover cover chains**:
   - Start from the original
   - Follow "Covered by" links
   - Note intermediate versions that may be more famous

## Mixtape Research Workflow

1. **Identify candidate songs** that fit the theme
2. **Search SHS for each song** to find its work page
3. **Check the genealogy**:
   - Who recorded it first?
   - Are there foreign language versions?
   - Any unexpected cover artists?
4. **Prefer**:
   - True originals over famous covers
   - Foreign adaptations over English defaults
   - Unexpected versions over obvious ones
5. **Document the genealogy** in playlist notes for listeners who want to dig deeper

## Example Research

Theme: Sugar songs

1. Search "Sugar Sugar" → Find work page
2. Discover The Archies (1969) is original
3. Find covers: Wilson Pickett (1970), Sinn Sisamouth (Cambodian version)
4. Choose Sinn Sisamouth for playlist - unexpected, pre-Khmer Rouge cultural artifact

## Data License

CC BY-NC 3.0 - Free for non-commercial use with attribution to "SecondHandSongs.com"

