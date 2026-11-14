# Project context: Harmonized Burning Activity Calendar

This repository is a hackathon project (NASA Space Apps 2026, Stalowa Wola). Treat the challenge below as the main context and goal for all work here. The user talks in Polish; reply in Polish.

## Challenge (original text)

Your challenge is to develop a harmonized burning activity calendar based on active fire hotspots in a web application, combining the extensive historical series of MODIS with the continuity and greater detail of VIIRS to provide a consistent time series of hotspot activity.

This challenge could be approached in two parts. The first is MODIS and VIIRS hotspot harmonization, so that by the end of that phase the sensor of origin no longer matters and the patterns, trends, and anomalies become the focus.

The second involves developing a web application that takes harmonized hotspot data as input. Through this visual tool, a user could select a region and a specific date range, then download analytics and visualizations of fire activity.

A calendar of burning activity showing the number of hotspots detected from the early 2000s to the present, built on the harmonized hotspots dataset and integrated into the web application, would give emergency managers a view of the fire history of an area: which periods of the year see more fires, which years had more burning activity, and how a current fire compares with previous ones.

In addition to numerical information, you could consider how color ramps might represent similarities and differences in the number of detected hotspots across months, providing an accessible and intuitive way to visualize fire activity. A downloadable CSV File of hot spots detected during a search would be another useful output.

## Key requirements (summary)

1. **Harmonization (part 1):** combine MODIS (from ~2000, 1 km) and VIIRS (from 2012, 375 m) active-fire hotspots into one consistent time series where the source sensor no longer matters.
2. **Web app (part 2):** takes the harmonized data as input; the user selects a region and a date range.
3. **Burning activity calendar:** hotspot counts from the early 2000s to the present (e.g. year × month grid), showing seasonal peaks, the most active years, and how the current period compares with history.
4. **Color ramps:** accessible, intuitive coloring of monthly hotspot counts.
5. **Outputs:** downloadable analytics/visualizations and a CSV of the hotspots found by a search.

Target users: emergency managers.
