from typing import Optional

SUSPICIOUS_VALUES = {11.11, 22.22, 33.33, 44.44, 55.55, 99.99}


def calculate_room_area(length_m: float, width_m: float) -> float:
    return round(length_m * width_m, 2)


def calculate_totals(rooms: list) -> dict:
    internal = round(sum(r["area_m2"] for r in rooms if not r.get("is_balcony", False)), 2)
    balcony = round(sum(r["area_m2"] for r in rooms if r.get("is_balcony", False)), 2)
    return {
        "total_internal_m2": internal,
        "total_balcony_m2": balcony,
        "total_m2": round(internal + balcony, 2),
    }


def validate_measurements(rooms: list) -> list:
    flags = []

    bathrooms = [r for r in rooms if "bathroom" in r.get("room_name", "").lower() or "ensuite" in r.get("room_name", "").lower()]
    bedrooms = [r for r in rooms if "bedroom" in r.get("room_name", "").lower()]

    for room in rooms:
        name = room.get("room_name", "Unknown")
        length = room.get("length_m") or 0
        width = room.get("width_m") or 0
        area = room.get("area_m2") or 0

        # Hard: missing measurements. A room measured via the guided plan has an area but
        # no length/width, so only flag as missing when there is no area either.
        if not area or area == 0:
            if not length or length == 0:
                flags.append({
                    "type": "hard",
                    "code": "MISSING_MEASUREMENT",
                    "message": f"MISSING_MEASUREMENT: {name} length is empty",
                })
            if not width or width == 0:
                flags.append({
                    "type": "hard",
                    "code": "MISSING_MEASUREMENT",
                    "message": f"MISSING_MEASUREMENT: {name} width is empty",
                })

        # Hard: unrealistic dimensions
        if length and length > 30:
            flags.append({
                "type": "hard",
                "code": "UNREALISTIC_SIZE",
                "message": f"UNREALISTIC_SIZE: {name} length of {length}m seems too large",
            })
        if width and width > 30:
            flags.append({
                "type": "hard",
                "code": "UNREALISTIC_SIZE",
                "message": f"UNREALISTIC_SIZE: {name} width of {width}m seems too large",
            })

        # Soft: suspicious values
        for val in (length, width):
            if val and round(float(val), 2) in SUSPICIOUS_VALUES:
                flags.append({
                    "type": "soft",
                    "code": "SUSPICIOUS_VALUE",
                    "message": f"SUSPICIOUS_VALUE: {name} has suspicious value {val}",
                })

    # Soft: bedroom smaller than bathroom
    for bedroom in bedrooms:
        b_area = bedroom.get("area_m2") or 0
        for bathroom in bathrooms:
            bt_area = bathroom.get("area_m2") or 0
            if b_area and bt_area and b_area < bt_area:
                flags.append({
                    "type": "soft",
                    "code": "BEDROOM_SMALLER_THAN_BATHROOM",
                    "message": (
                        f"BEDROOM_SMALLER_THAN_BATHROOM: {bedroom['room_name']} ({b_area}m2) "
                        f"is smaller than {bathroom['room_name']} ({bt_area}m2)"
                    ),
                })

    # Compute totals for soft total checks
    internal = sum(r.get("area_m2") or 0 for r in rooms if not r.get("is_balcony", False))
    balcony = sum(r.get("area_m2") or 0 for r in rooms if r.get("is_balcony", False))

    if internal > 0 and internal < 20:
        flags.append({
            "type": "soft",
            "code": "TOTAL_TOO_SMALL",
            "message": f"TOTAL_TOO_SMALL: Total internal area {round(internal, 2)}m2 is unusually small",
        })
    if internal > 300:
        flags.append({
            "type": "soft",
            "code": "TOTAL_TOO_LARGE",
            "message": f"TOTAL_TOO_LARGE: Total internal area {round(internal, 2)}m2 is unusually large",
        })
    if balcony > 0 and internal > 0 and balcony > internal:
        flags.append({
            "type": "soft",
            "code": "BALCONY_LARGER_THAN_INTERNAL",
            "message": f"BALCONY_LARGER_THAN_INTERNAL: Balcony {round(balcony, 2)}m2 is larger than internal {round(internal, 2)}m2",
        })

    return flags
