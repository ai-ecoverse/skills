# Foursquare API v2 — Endpoint Reference

Base URL: `https://api.foursquare.com/v2/`

All requests require `?v=20231001` (API version date parameter).

Authentication is via page-context fetch from an open `app.foursquare.com` tab
(cookies sent automatically with `credentials: 'include'`).

---

## GET /users/self/checkins

User's check-in history.

### Parameters

| Param      | Type   | Default | Description                  |
|------------|--------|---------|------------------------------|
| limit      | int    | 20      | Number of results (max 250)  |
| offset     | int    | 0       | Pagination offset            |
| categoryId | string | -       | Filter by category ID        |
| v          | string | -       | API version (YYYYMMDD)       |

### Example Request

```
GET /users/self/checkins?v=20231001&limit=5&offset=0
```

### Example Response

```json
{
  "meta": { "code": 200 },
  "response": {
    "checkins": {
      "count": 4823,
      "items": [
        {
          "id": "664a1b...",
          "createdAt": 1716123456,
          "type": "checkin",
          "venue": {
            "id": "4b5a0c05f964a5200a4f28e3",
            "name": "Café Einstein",
            "location": {
              "address": "Kurfürstenstr. 58",
              "city": "Berlin",
              "state": "Berlin",
              "country": "Germany",
              "lat": 52.5045,
              "lng": 13.3555
            },
            "categories": [
              {
                "id": "4bf58dd8d48988d16d941735",
                "name": "Café",
                "primary": true
              }
            ]
          }
        }
      ]
    }
  }
}
```

---

## GET /users/self/venuehistory

Venue visit history with counts.

### Parameters

| Param      | Type   | Description            |
|------------|--------|------------------------|
| categoryId | string | Filter by category ID  |
| v          | string | API version (YYYYMMDD) |

### Example Request

```
GET /users/self/venuehistory?v=20231001
```

### Example Response

```json
{
  "meta": { "code": 200 },
  "response": {
    "venues": {
      "count": 1245,
      "items": [
        {
          "beenHere": 47,
          "venue": {
            "id": "4b5a0c05f964a5200a4f28e3",
            "name": "Café Einstein",
            "location": {
              "city": "Berlin",
              "country": "Germany",
              "lat": 52.5045,
              "lng": 13.3555
            },
            "categories": [
              {
                "id": "4bf58dd8d48988d16d941735",
                "name": "Café"
              }
            ]
          }
        }
      ]
    }
  }
}
```

---

## GET /venues/search

Search for venues near a location.

### Parameters

| Param  | Type   | Description                          |
|--------|--------|--------------------------------------|
| ll     | string | Latitude,longitude (e.g. 52.52,13.4) |
| query  | string | Search query                         |
| limit  | int    | Max results (default 10)             |
| v      | string | API version (YYYYMMDD)               |

### Example Request

```
GET /venues/search?v=20231001&ll=52.52,13.405&query=sushi&limit=5
```

### Example Response

```json
{
  "meta": { "code": 200 },
  "response": {
    "venues": [
      {
        "id": "5a1b2c3d4e5f...",
        "name": "Omoni Sushi",
        "location": {
          "address": "Kantstr. 12",
          "city": "Berlin",
          "country": "Germany",
          "lat": 52.5067,
          "lng": 13.3189,
          "distance": 450
        },
        "categories": [
          {
            "id": "4bf58dd8d48988d1d2941735",
            "name": "Sushi Restaurant"
          }
        ]
      }
    ]
  }
}
```

---

## GET /venues/:id

Detailed venue information.

### Parameters

| Param | Type   | Description            |
|-------|--------|------------------------|
| v     | string | API version (YYYYMMDD) |

### Example Request

```
GET /venues/4b5a0c05f964a5200a4f28e3?v=20231001
```

### Example Response

```json
{
  "meta": { "code": 200 },
  "response": {
    "venue": {
      "id": "4b5a0c05f964a5200a4f28e3",
      "name": "Café Einstein",
      "url": "https://cafeeinstein.com",
      "rating": 8.7,
      "location": {
        "address": "Kurfürstenstr. 58",
        "city": "Berlin",
        "state": "Berlin",
        "country": "Germany",
        "lat": 52.5045,
        "lng": 13.3555
      },
      "categories": [
        {
          "id": "4bf58dd8d48988d16d941735",
          "name": "Café",
          "primary": true
        }
      ],
      "beenHere": {
        "count": 47,
        "lastCheckinExpiredAt": 0
      },
      "hours": {
        "status": "Open until 11:00 PM",
        "isOpen": true
      }
    }
  }
}
```

---

## Common Category IDs

| Category   | ID                               |
|------------|----------------------------------|
| Sushi      | `4bf58dd8d48988d1d2941735`       |
| Japanese   | `4bf58dd8d48988d111941735`       |
| Café       | `4bf58dd8d48988d16d941735`       |
| Bar        | `4bf58dd8d48988d116941735`       |
| Restaurant | `4bf58dd8d48988d1c4941735`       |
| Hotel      | `4bf58dd8d48988d1fa931735`       |
| Airport    | `4bf58dd8d48988d1ed931735`       |

---

## Auth Notes

- Direct API calls with `oauth_token` param return 401 for this user's token
- Page-context fetch from `app.foursquare.com` works because session cookies
  are sent automatically with `credentials: 'include'`
- The `playwright-cli eval --tab=<id>` mechanism executes in the tab's context
